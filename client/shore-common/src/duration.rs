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
