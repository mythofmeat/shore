use std::fmt;
use std::time::Duration;

use serde::de;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

const MILLIS_PER_SECOND: u64 = 1_000;
const MILLIS_PER_MINUTE: u64 = 60_000;
const MILLIS_PER_HOUR: u64 = 3_600_000;
const MILLIS_PER_DAY: u64 = 86_400_000;

/// A duration type that parses systemd-style strings (`500ms`, `30s`, `2m`, `1h`, `2d`).
///
/// Bare integers (no suffix) are treated as seconds for backwards compatibility.
/// Internally stored as milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ConfigDuration(u64);

impl ConfigDuration {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let s = raw.trim();
        if s.is_empty() {
            return Err("duration string is empty".into());
        }

        if s.starts_with('-') {
            return Err("duration cannot be negative".into());
        }

        // Try bare integer (no suffix) -> seconds
        if let Ok(secs) = s.parse::<u64>() {
            let millis = secs
                .checked_mul(1000)
                .ok_or_else(|| format!("duration too large: {s}"))?;
            return Ok(Self(millis));
        }

        // Find where the numeric part ends and the suffix begins.
        // Accept digits and '.' so fractional values like "1.5h" work.
        let digit_end = s
            .find(|c: char| !c.is_ascii_digit() && c != '.')
            .ok_or_else(|| format!("invalid duration: {s}"))?;

        let (num_str, suffix) = s.split_at(digit_end);

        let millis = match suffix {
            "ms" => millis_from_decimal_unit(num_str, 1, s)?,
            "s" => millis_from_decimal_unit(num_str, MILLIS_PER_SECOND, s)?,
            "m" => millis_from_decimal_unit(num_str, MILLIS_PER_MINUTE, s)?,
            "h" => millis_from_decimal_unit(num_str, MILLIS_PER_HOUR, s)?,
            "d" => millis_from_decimal_unit(num_str, MILLIS_PER_DAY, s)?,
            _ => return Err(format!("invalid duration suffix: {suffix}")),
        };

        Ok(Self(millis))
    }

    pub const fn from_secs(secs: u64) -> Self {
        Self(secs.saturating_mul(MILLIS_PER_SECOND))
    }

    pub const fn from_millis(millis: u64) -> Self {
        Self(millis)
    }

    pub const fn as_secs(&self) -> u64 {
        match self.0.checked_div(MILLIS_PER_SECOND) {
            Some(seconds) => seconds,
            None => 0,
        }
    }

    pub const fn as_millis(&self) -> u64 {
        self.0
    }

    pub const fn as_duration(&self) -> Duration {
        Duration::from_millis(self.0)
    }
}

fn millis_from_decimal_unit(decimal: &str, unit_millis: u64, raw: &str) -> Result<u64, String> {
    let (whole_digits, fractional_digits) = decimal_parts(decimal, raw)?;
    let whole_units = parse_whole_digits(whole_digits, raw)?;
    let whole_millis = whole_units
        .checked_mul(unit_millis)
        .ok_or_else(|| format!("duration too large: {raw}"))?;
    let fractional_millis = match fractional_digits {
        Some(digits) => millis_from_fractional_digits(digits, unit_millis, raw)?,
        None => 0,
    };

    whole_millis
        .checked_add(fractional_millis)
        .ok_or_else(|| format!("duration too large: {raw}"))
}

fn decimal_parts<'duration>(
    decimal: &'duration str,
    raw: &str,
) -> Result<(&'duration str, Option<&'duration str>), String> {
    if decimal.is_empty() || decimal == "." {
        return Err(format!("invalid number in duration: {raw}"));
    }

    if let Some((whole_digits, fractional_digits)) = decimal.split_once('.') {
        if fractional_digits.contains('.')
            || whole_digits.is_empty() && fractional_digits.is_empty()
        {
            return Err(format!("invalid number in duration: {raw}"));
        }
        Ok((whole_digits, Some(fractional_digits)))
    } else {
        Ok((decimal, None))
    }
}

fn parse_whole_digits(digits: &str, raw: &str) -> Result<u64, String> {
    if digits.is_empty() {
        return Ok(0);
    }

    digits
        .parse()
        .map_err(|_| format!("duration too large: {raw}"))
}

fn millis_from_fractional_digits(digits: &str, unit_millis: u64, raw: &str) -> Result<u64, String> {
    if digits.is_empty() {
        return Ok(0);
    }

    let fractional_units = digits
        .parse::<u128>()
        .map_err(|_| format!("duration fractional precision is too large: {raw}"))?;
    let digit_count = u32::try_from(digits.len())
        .map_err(|_| format!("duration fractional precision is too large: {raw}"))?;
    let scale = 10_u128
        .checked_pow(digit_count)
        .ok_or_else(|| format!("duration fractional precision is too large: {raw}"))?;
    let scaled_fractional_millis = fractional_units
        .checked_mul(u128::from(unit_millis))
        .ok_or_else(|| format!("duration fractional precision is too large: {raw}"))?;
    let fractional_millis = scaled_fractional_millis
        .checked_div(scale)
        .ok_or_else(|| format!("duration fractional precision is too large: {raw}"))?;

    u64::try_from(fractional_millis).map_err(|_| format!("duration too large: {raw}"))
}

fn millis_from_secs_f64(secs: f64) -> Result<u64, String> {
    let duration = Duration::try_from_secs_f64(secs)
        .map_err(|_| "duration must be finite, non-negative, and in range".to_owned())?;
    u64::try_from(duration.as_millis()).map_err(|_| "duration is too large".to_owned())
}

impl fmt::Display for ConfigDuration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let ms = self.0;
        if ms == 0 {
            return write!(f, "0s");
        }
        if ms.is_multiple_of(MILLIS_PER_DAY) {
            let days = ms.checked_div(MILLIS_PER_DAY).ok_or(fmt::Error)?;
            write!(f, "{days}d")
        } else if ms.is_multiple_of(MILLIS_PER_HOUR) {
            let hours = ms.checked_div(MILLIS_PER_HOUR).ok_or(fmt::Error)?;
            write!(f, "{hours}h")
        } else if ms.is_multiple_of(MILLIS_PER_MINUTE) {
            let minutes = ms.checked_div(MILLIS_PER_MINUTE).ok_or(fmt::Error)?;
            write!(f, "{minutes}m")
        } else if ms.is_multiple_of(MILLIS_PER_SECOND) {
            let seconds = ms.checked_div(MILLIS_PER_SECOND).ok_or(fmt::Error)?;
            write!(f, "{seconds}s")
        } else {
            write!(f, "{ms}ms")
        }
    }
}

impl Serialize for ConfigDuration {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for ConfigDuration {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ConfigDurationVisitor;

        impl de::Visitor<'_> for ConfigDurationVisitor {
            type Value = ConfigDuration;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a duration string (e.g. \"30s\", \"2m\"), or a number (seconds)")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<ConfigDuration, E> {
                ConfigDuration::parse(v).map_err(de::Error::custom)
            }

            fn visit_u64<E: de::Error>(self, v: u64) -> Result<ConfigDuration, E> {
                Ok(ConfigDuration::from_secs(v))
            }

            fn visit_i64<E: de::Error>(self, v: i64) -> Result<ConfigDuration, E> {
                if v < 0 {
                    return Err(de::Error::custom("duration cannot be negative"));
                }
                // Non-negativity is guaranteed by the guard above.
                Ok(ConfigDuration::from_secs(v.cast_unsigned()))
            }

            fn visit_f64<E: de::Error>(self, v: f64) -> Result<ConfigDuration, E> {
                if v < 0.0 {
                    return Err(de::Error::custom("duration cannot be negative"));
                }
                let millis = millis_from_secs_f64(v).map_err(de::Error::custom)?;
                Ok(ConfigDuration::from_millis(millis))
            }
        }

        deserializer.deserialize_any(ConfigDurationVisitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_milliseconds() {
        assert_eq!(
            ConfigDuration::parse("500ms").unwrap(),
            ConfigDuration::from_millis(500)
        );
    }

    #[test]
    fn parse_seconds() {
        assert_eq!(
            ConfigDuration::parse("30s").unwrap(),
            ConfigDuration::from_secs(30)
        );
    }

    #[test]
    fn parse_minutes() {
        assert_eq!(
            ConfigDuration::parse("2m").unwrap(),
            ConfigDuration::from_millis(2 * 60 * 1000)
        );
    }

    #[test]
    fn parse_hours() {
        assert_eq!(
            ConfigDuration::parse("1h").unwrap(),
            ConfigDuration::from_millis(3600 * 1000)
        );
    }

    #[test]
    fn parse_days() {
        assert_eq!(
            ConfigDuration::parse("2d").unwrap(),
            ConfigDuration::from_millis(2 * 86400 * 1000)
        );
    }

    #[test]
    fn parse_bare_number_is_seconds() {
        assert_eq!(
            ConfigDuration::parse("30").unwrap(),
            ConfigDuration::from_secs(30)
        );
    }

    #[test]
    fn parse_whitespace_trimmed() {
        assert_eq!(
            ConfigDuration::parse("  30s  ").unwrap(),
            ConfigDuration::from_secs(30)
        );
    }

    #[test]
    fn parse_invalid_suffix() {
        assert!(ConfigDuration::parse("30x").is_err());
    }

    #[test]
    fn parse_empty_string() {
        assert!(ConfigDuration::parse("").is_err());
        assert!(ConfigDuration::parse("   ").is_err());
    }

    #[test]
    fn parse_negative() {
        assert!(ConfigDuration::parse("-5s").is_err());
    }

    #[test]
    fn display_roundtrip() {
        assert_eq!(ConfigDuration::from_millis(3600 * 1000).to_string(), "1h");
        assert_eq!(ConfigDuration::from_millis(90 * 1000).to_string(), "90s");
        assert_eq!(ConfigDuration::from_millis(500).to_string(), "500ms");
        assert_eq!(ConfigDuration::from_millis(0).to_string(), "0s");
        assert_eq!(
            ConfigDuration::from_millis(2 * 86400 * 1000).to_string(),
            "2d"
        );
        assert_eq!(ConfigDuration::from_millis(120 * 1000).to_string(), "2m");
    }

    #[test]
    fn serde_deserialize_string() {
        let d: ConfigDuration = serde_json::from_str("\"30s\"").unwrap();
        assert_eq!(d, ConfigDuration::from_secs(30));
    }

    #[test]
    fn serde_deserialize_integer() {
        let d: ConfigDuration = serde_json::from_str("30").unwrap();
        assert_eq!(d, ConfigDuration::from_secs(30));
    }

    #[test]
    fn serde_serialize_human_readable() {
        let d = ConfigDuration::from_secs(3600);
        let s = serde_json::to_string(&d).unwrap();
        assert_eq!(s, "\"1h\"");
    }

    #[test]
    fn as_std_duration() {
        let d = ConfigDuration::from_secs(5);
        assert_eq!(d.as_duration(), Duration::from_secs(5));
    }

    /// Fractional durations like "1.5h" are reasonable user input but
    /// currently fail because the parser splits at the first non-digit
    /// character (`.`), producing num_str="1" and suffix=".5h".
    #[test]
    fn parse_fractional_duration() {
        // "1.5h" should parse as 1 hour 30 minutes = 5400 seconds.
        let result = ConfigDuration::parse("1.5h");
        assert!(
            result.is_ok(),
            "Fractional duration '1.5h' should be parseable, got: {:?}",
            result.err()
        );
        assert_eq!(result.unwrap(), ConfigDuration::from_millis(5400 * 1000));
    }
}
