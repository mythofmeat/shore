use std::collections::BTreeSet;
use std::fmt;

use chrono::{
    DateTime, Datelike, Days, Duration, Local, LocalResult, NaiveDate, TimeZone, Timelike,
};

const MAX_CRON_SEARCH_DAYS: u32 = 366 * 8;

const MONTH_ALIASES: &[(&str, u32)] = &[
    ("JAN", 1),
    ("FEB", 2),
    ("MAR", 3),
    ("APR", 4),
    ("MAY", 5),
    ("JUN", 6),
    ("JUL", 7),
    ("AUG", 8),
    ("SEP", 9),
    ("OCT", 10),
    ("NOV", 11),
    ("DEC", 12),
];

const DOW_ALIASES: &[(&str, u32)] = &[
    ("SUN", 0),
    ("MON", 1),
    ("TUE", 2),
    ("WED", 3),
    ("THU", 4),
    ("FRI", 5),
    ("SAT", 6),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronError {
    message: String,
}

impl CronError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for CronError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CronError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronSchedule {
    minute: CronField,
    hour: CronField,
    day_of_month: CronField,
    month: CronField,
    day_of_week: CronField,
}

impl CronSchedule {
    pub fn parse(expr: &str) -> Result<Self, CronError> {
        let parts: Vec<&str> = expr.split_whitespace().collect();
        if parts.len() != 5 {
            return Err(CronError::new(format!(
                "expected five fields (minute hour day-of-month month day-of-week), got {}",
                parts.len()
            )));
        }

        let [minute, hour, day_of_month, month, day_of_week] = parts.as_slice() else {
            return Err(CronError::new(format!(
                "expected five fields (minute hour day-of-month month day-of-week), got {}",
                parts.len()
            )));
        };

        let schedule = Self {
            minute: CronField::parse(minute, FieldSpec::minute())?,
            hour: CronField::parse(hour, FieldSpec::hour())?,
            day_of_month: CronField::parse(day_of_month, FieldSpec::day_of_month())?,
            month: CronField::parse(month, FieldSpec::month())?,
            day_of_week: CronField::parse(day_of_week, FieldSpec::day_of_week())?,
        };
        schedule.validate_calendar_match()?;
        Ok(schedule)
    }

    pub fn next_after(&self, after: DateTime<Local>) -> Option<DateTime<Local>> {
        let cursor = floor_to_minute(after).checked_add_signed(Duration::minutes(1))?;
        let cursor_date = cursor.date_naive();
        let mut date = cursor_date;

        for _ in 0..=MAX_CRON_SEARCH_DAYS {
            if self.matches_date(date) {
                let same_day = date == cursor_date;
                for &hour in &self.hour.values {
                    if same_day && hour < cursor.hour() {
                        continue;
                    }
                    for &minute in &self.minute.values {
                        if same_day && hour == cursor.hour() && minute < cursor.minute() {
                            continue;
                        }
                        for candidate in local_datetimes(date, hour, minute) {
                            if candidate > after {
                                return Some(candidate);
                            }
                        }
                    }
                }
            }

            date = date.succ_opt()?;
        }

        None
    }

    pub fn initial_due_window_start(&self, now: DateTime<Local>) -> DateTime<Local> {
        let date = now.date_naive();
        let start_date = if !self.month.wildcard {
            NaiveDate::from_ymd_opt(now.year(), 1, 1).unwrap_or(date)
        } else if !self.day_of_month.wildcard {
            NaiveDate::from_ymd_opt(now.year(), now.month(), 1).unwrap_or(date)
        } else if !self.day_of_week.wildcard {
            date.checked_sub_days(Days::new(u64::from(date.weekday().num_days_from_monday())))
                .unwrap_or(date)
        } else {
            date
        };

        start_of_local_day(start_date, now)
    }

    pub fn matches_datetime(&self, dt: DateTime<Local>) -> bool {
        dt.second() == 0
            && self.minute.matches(dt.minute())
            && self.hour.matches(dt.hour())
            && self.matches_date(dt.date_naive())
    }

    fn matches_date(&self, date: NaiveDate) -> bool {
        if !self.month.matches(date.month()) {
            return false;
        }

        let day_of_month_matches = self.day_of_month.matches(date.day());
        let day_of_week_matches = self
            .day_of_week
            .matches(date.weekday().num_days_from_sunday());

        match (self.day_of_month.wildcard, self.day_of_week.wildcard) {
            (true, true) => true,
            (true, false) => day_of_week_matches,
            (false, true) => day_of_month_matches,
            (false, false) => day_of_month_matches || day_of_week_matches,
        }
    }

    fn validate_calendar_match(&self) -> Result<(), CronError> {
        if self.day_of_month.wildcard || !self.day_of_week.wildcard {
            return Ok(());
        }

        let has_valid_day = self.month.values.iter().any(|&month| {
            let max_day = max_day_in_month(month);
            self.day_of_month.values.iter().any(|&day| day <= max_day)
        });
        if has_valid_day {
            Ok(())
        } else {
            Err(CronError::new(
                "day-of-month and month fields never match a calendar date",
            ))
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CronField {
    values: Vec<u32>,
    wildcard: bool,
}

impl CronField {
    fn parse(raw: &str, spec: FieldSpec) -> Result<Self, CronError> {
        if raw.is_empty() {
            return Err(CronError::new(format!("{} field is empty", spec.name)));
        }

        let mut values = BTreeSet::new();
        for item in raw.split(',') {
            if item.is_empty() {
                return Err(CronError::new(format!(
                    "{} field contains an empty list item",
                    spec.name
                )));
            }
            parse_list_item(item, spec, &mut values)?;
        }

        if values.is_empty() {
            return Err(CronError::new(format!("{} field has no values", spec.name)));
        }

        let full_values = spec.full_values();
        let wildcard = values.len() == full_values.len()
            && full_values.iter().all(|value| values.contains(value));

        Ok(Self {
            values: values.into_iter().collect(),
            wildcard,
        })
    }

    fn matches(&self, value: u32) -> bool {
        self.values.binary_search(&value).is_ok()
    }
}

#[derive(Debug, Clone, Copy)]
struct FieldSpec {
    name: &'static str,
    min: u32,
    max: u32,
    star_min: u32,
    star_max: u32,
    aliases: &'static [(&'static str, u32)],
    sunday_alias: bool,
}

impl FieldSpec {
    fn minute() -> Self {
        Self::new("minute", 0, 59)
    }

    fn hour() -> Self {
        Self::new("hour", 0, 23)
    }

    fn day_of_month() -> Self {
        Self::new("day-of-month", 1, 31)
    }

    fn month() -> Self {
        Self {
            aliases: MONTH_ALIASES,
            ..Self::new("month", 1, 12)
        }
    }

    fn day_of_week() -> Self {
        Self {
            name: "day-of-week",
            min: 0,
            max: 7,
            star_min: 0,
            star_max: 6,
            aliases: DOW_ALIASES,
            sunday_alias: true,
        }
    }

    const fn new(name: &'static str, min: u32, max: u32) -> Self {
        Self {
            name,
            min,
            max,
            star_min: min,
            star_max: max,
            aliases: &[],
            sunday_alias: false,
        }
    }

    fn normalize(self, value: u32) -> u32 {
        if self.sunday_alias && value == 7 {
            0
        } else {
            value
        }
    }

    fn full_values(self) -> BTreeSet<u32> {
        (self.star_min..=self.star_max)
            .map(|value| self.normalize(value))
            .collect()
    }
}

fn parse_list_item(
    item: &str,
    spec: FieldSpec,
    values: &mut BTreeSet<u32>,
) -> Result<(), CronError> {
    let mut step_parts = item.split('/');
    let base = step_parts.next().unwrap_or_default();
    let step = match step_parts.next() {
        Some(raw_step) => {
            if step_parts.next().is_some() {
                return Err(CronError::new(format!(
                    "{} field item {item:?} contains multiple steps",
                    spec.name
                )));
            }
            let step = raw_step.parse::<u32>().map_err(|_| {
                CronError::new(format!(
                    "{} field item {item:?} has invalid step {raw_step:?}",
                    spec.name
                ))
            })?;
            if step == 0 {
                return Err(CronError::new(format!(
                    "{} field item {item:?} has a zero step",
                    spec.name
                )));
            }
            Some(step)
        }
        None => None,
    };

    if base.is_empty() {
        return Err(CronError::new(format!(
            "{} field item {item:?} is missing a base value",
            spec.name
        )));
    }

    if base == "*" {
        insert_range(
            values,
            spec,
            spec.star_min,
            spec.star_max,
            step.unwrap_or(1),
        );
        return Ok(());
    }

    if let Some((start_raw, end_raw)) = base.split_once('-') {
        if end_raw.contains('-') {
            return Err(CronError::new(format!(
                "{} field item {item:?} contains multiple ranges",
                spec.name
            )));
        }
        let start = parse_value(start_raw, spec)?;
        let mut end = parse_value(end_raw, spec)?;
        if spec.sunday_alias && end == 0 && start > 0 {
            end = 7;
        }
        if start > end {
            return Err(CronError::new(format!(
                "{} field item {item:?} has a descending range",
                spec.name
            )));
        }
        insert_range(values, spec, start, end, step.unwrap_or(1));
        return Ok(());
    }

    let start = parse_value(base, spec)?;
    if let Some(stride) = step {
        insert_range(values, spec, start, spec.max, stride);
    } else {
        let _ignored = values.insert(spec.normalize(start));
    }
    Ok(())
}

fn insert_range(values: &mut BTreeSet<u32>, spec: FieldSpec, start: u32, end: u32, step: u32) {
    let Ok(stride) = usize::try_from(step) else {
        return;
    };
    for value in (start..=end).step_by(stride) {
        let _ignored = values.insert(spec.normalize(value));
    }
}

fn parse_value(raw: &str, spec: FieldSpec) -> Result<u32, CronError> {
    if raw.is_empty() {
        return Err(CronError::new(format!(
            "{} field contains an empty value",
            spec.name
        )));
    }

    let upper = raw.to_ascii_uppercase();
    let parsed = spec
        .aliases
        .iter()
        .find_map(|&(name, value)| (name == upper).then_some(value))
        .or_else(|| raw.parse::<u32>().ok())
        .ok_or_else(|| {
            CronError::new(format!(
                "{} field value {raw:?} is not a number or known name",
                spec.name
            ))
        })?;

    if parsed < spec.min || parsed > spec.max {
        return Err(CronError::new(format!(
            "{} field value {raw:?} is outside {}-{}",
            spec.name, spec.min, spec.max
        )));
    }

    Ok(parsed)
}

fn floor_to_minute(dt: DateTime<Local>) -> DateTime<Local> {
    dt.with_second(0)
        .and_then(|t| t.with_nanosecond(0))
        .unwrap_or(dt)
}

fn local_datetimes(date: NaiveDate, hour: u32, minute: u32) -> Vec<DateTime<Local>> {
    let Some(naive) = date.and_hms_opt(hour, minute, 0) else {
        return Vec::new();
    };
    let mut candidates = match Local.from_local_datetime(&naive) {
        LocalResult::Single(dt) => vec![dt],
        LocalResult::Ambiguous(first, second) => vec![first, second],
        LocalResult::None => Vec::new(),
    };
    candidates.sort();
    candidates
}

fn start_of_local_day(date: NaiveDate, fallback: DateTime<Local>) -> DateTime<Local> {
    local_datetimes(date, 0, 0)
        .into_iter()
        .next()
        .unwrap_or(fallback)
}

fn max_day_in_month(month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 29,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_weekly_and_named_cron() {
        assert!(CronSchedule::parse("0 6 * * 1").is_ok());
        assert!(CronSchedule::parse("*/15 9-17 * JAN,MAR MON-FRI").is_ok());
        assert!(CronSchedule::parse("0 6 * * 7").is_ok());
    }

    #[test]
    fn rejects_invalid_cron_shapes() {
        assert!(CronSchedule::parse("0 6 * *").is_err());
        assert!(CronSchedule::parse("60 6 * * *").is_err());
        assert!(CronSchedule::parse("0 24 * * *").is_err());
        assert!(CronSchedule::parse("0 6 * * MON//2").is_err());
        assert!(CronSchedule::parse("0 6 * * MON/0").is_err());
        assert!(CronSchedule::parse("0 6 31 FEB *").is_err());
    }
}
