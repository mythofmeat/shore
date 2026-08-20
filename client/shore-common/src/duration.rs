const MILLIS_PER_SECOND: u64 = 1_000;
const MILLIS_PER_MINUTE: u64 = 60_000;
const MILLIS_PER_HOUR: u64 = 3_600_000;

const MILLIS_PER_TENTH_OF_A_SECOND: u64 = 100;
const MILLIS_PER_HUNDREDTH_OF_A_MINUTE: u64 = 600;
const MILLIS_PER_HUNDREDTH_OF_AN_HOUR: u64 = 36_000;

fn div(value: u64, divisor: u64) -> u64 {
    value.checked_div(divisor).unwrap_or_default()
}

fn rem(value: u64, divisor: u64) -> u64 {
    value.checked_rem(divisor).unwrap_or_default()
}

pub fn format_duration_ms(ms: u64) -> String {
    if ms < MILLIS_PER_SECOND {
        return format!("{ms}ms");
    }
    if ms < MILLIS_PER_MINUTE {
        let whole = div(ms, MILLIS_PER_SECOND);
        let tenths = div(rem(ms, MILLIS_PER_SECOND), MILLIS_PER_TENTH_OF_A_SECOND);
        return format!("{whole}.{tenths}s");
    }
    if ms < MILLIS_PER_HOUR {
        let whole = div(ms, MILLIS_PER_MINUTE);
        let hundredths = div(rem(ms, MILLIS_PER_MINUTE), MILLIS_PER_HUNDREDTH_OF_A_MINUTE);
        return format!("{whole}.{hundredths:02}m");
    }
    let whole = div(ms, MILLIS_PER_HOUR);
    let hundredths = div(rem(ms, MILLIS_PER_HOUR), MILLIS_PER_HUNDREDTH_OF_AN_HOUR);
    format!("{whole}.{hundredths:02}h")
}

#[cfg(test)]
mod tests {
    use super::format_duration_ms;

    #[test]
    fn the_table_from_the_issue() {
        assert_eq!(format_duration_ms(500), "500ms");
        assert_eq!(format_duration_ms(999), "999ms");
        assert_eq!(format_duration_ms(1_500), "1.5s");
        assert_eq!(format_duration_ms(61_000), "1.01m");
    }

    #[test]
    fn every_unit_starts_the_moment_one_whole_of_it_exists() {
        assert_eq!(format_duration_ms(0), "0ms");
        assert_eq!(format_duration_ms(1_000), "1.0s");
        assert_eq!(format_duration_ms(59_999), "59.9s");
        assert_eq!(format_duration_ms(60_000), "1.00m");
        assert_eq!(format_duration_ms(3_599_999), "59.99m");
        assert_eq!(format_duration_ms(3_600_000), "1.00h");
    }

    #[test]
    fn the_reading_that_prompted_this_is_no_longer_five_digits() {
        assert_eq!(format_duration_ms(60_499), "1.00m");
        assert_eq!(format_duration_ms(8_240), "8.2s");
    }

    #[test]
    fn a_fraction_is_truncated_rather_than_rounded_up_past_its_unit() {
        assert_eq!(format_duration_ms(1_999), "1.9s");
        assert_eq!(format_duration_ms(119_999), "1.99m");
    }

    #[test]
    fn a_run_longer_than_a_day_still_reads_in_hours() {
        assert_eq!(format_duration_ms(90_000_000), "25.00h");
    }

    #[test]
    fn no_reading_is_wider_than_the_one_it_replaces() {
        for ms in [999_u64, 59_999, 3_599_999, 359_999_999] {
            assert!(
                format_duration_ms(ms).len() <= format!("{ms}ms").len(),
                "{ms} must not render wider than its raw millisecond reading"
            );
        }
    }
}
