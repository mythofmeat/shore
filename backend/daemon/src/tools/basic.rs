//! Basic tools: roll_dice.
//!
//! Migrated from the legacy `engine/tools.rs` ToolRegistry.
//!
//! Time is not a tool. The chat path injects a time marker on the user message
//! (see `engine::prompt`) and the heartbeat prepends `[Current time: …]` to
//! every tick, so the model reads the clock from its prompt rather than
//! spending a tool round-trip to ask for it.

use chrono::{Datelike, Local};
use rand::Rng;
use serde_json::{json, Value};

use super::{ToolCategory, ToolDef, ToolError};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

pub fn tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "roll_dice",
            description: crate::include_prompt!("../../prompts/tools/basic/roll_dice.md"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "notation": {
                        "type": "string",
                        "description": "Dice notation: NdS[+/-M]. Examples: '2d6', '1d20+5', '4d6-1'."
                    }
                },
                "required": ["notation"]
            }),
            category: ToolCategory::Other,
        },
        // NOTE: `set_next_wake` is intentionally NOT declared here. It is a
        // heartbeat-only capability — declaring it would put a tool that's
        // meaningless in chat on the chat tool surface, and (because the tools
        // array is the head of the Anthropic cache prefix) any chat/heartbeat
        // divergence would bust the cache. Instead the heartbeat prompt
        // instructs the model to call `set_next_wake(hours_from_now, reason)`,
        // and the heartbeat tool loop intercepts that (undeclared) call by name
        // (see `dispatch_heartbeat_tools`). The model emitting a tool_use for an
        // undeclared name round-trips fine; the harness handles it.
    ]
}

// ---------------------------------------------------------------------------
// Friendly datetime formatting
// ---------------------------------------------------------------------------

fn ordinal_suffix(n: u32) -> &'static str {
    match (n % 10, n % 100) {
        (1, 11) | (2, 12) | (3, 13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    }
}

/// Human-friendly local date, e.g. `"Saturday, April 4th, 2026"`. Feeds the
/// `{{date}}` template variable so prompts can anchor freshness to "today".
pub(crate) fn format_friendly_date() -> String {
    let now = Local::now();
    let day = now.day();
    let suffix = ordinal_suffix(day);
    now.format(&format!("%A, %B {day}{suffix}, %Y")).to_string()
}

/// Human-friendly local time, e.g. `"4:34 PM"`. Feeds the `{{time}}` variable.
pub(crate) fn format_friendly_time() -> String {
    Local::now().format("%-I:%M %p").to_string()
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub fn handle_roll_dice(input: &Value) -> Result<Value, ToolError> {
    let notation_str = input
        .get("notation")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidArgs("missing 'notation' parameter".into()))?;

    let parsed = parse_dice_notation(notation_str)
        .map_err(|e| ToolError::InvalidArgs(format!("invalid dice notation: {e}")))?;

    let (rolls, total) = execute_dice_roll(&parsed);
    Ok(json!({
        "notation": notation_str,
        "rolls": rolls,
        "total": total,
    }))
}

// ---------------------------------------------------------------------------
// Dice notation parsing (migrated from engine/tools.rs)
// ---------------------------------------------------------------------------

/// Parsed dice notation (e.g., `2d6+3` → count=2, sides=6, modifier=3).
#[derive(Debug, Clone, PartialEq)]
pub struct DiceNotation {
    pub count: u32,
    pub sides: u32,
    pub modifier: i32,
}

/// Parse dice notation like `2d6+3`, `1d20`, `4d6-1`, `d8`.
pub fn parse_dice_notation(notation: &str) -> Result<DiceNotation, String> {
    let s = notation.trim().to_lowercase();

    let d_pos = s
        .find('d')
        .ok_or_else(|| format!("Missing 'd' in notation: {notation}"))?;

    let count_str = s.get(..d_pos).unwrap_or("");
    let count = if count_str.is_empty() {
        1
    } else {
        count_str
            .parse::<u32>()
            .map_err(|_| format!("Invalid dice count: {count_str}"))?
    };
    if count == 0 {
        return Err("Dice count must be at least 1".into());
    }

    let after_d = s.get(d_pos.saturating_add(1)..).unwrap_or("");
    if after_d.is_empty() {
        return Err("Missing sides after 'd'".into());
    }

    let modifier_pos = after_d
        .char_indices()
        .find_map(|(i, c)| (i > 0 && (c == '+' || c == '-')).then_some(i));

    let (sides_str, modifier) = if let Some(byte_pos) = modifier_pos {
        let sides = after_d.get(..byte_pos).unwrap_or("");
        let mod_str = after_d.get(byte_pos..).unwrap_or("");
        let modifier = mod_str
            .parse::<i32>()
            .map_err(|_| format!("Invalid modifier: {mod_str}"))?;
        (sides, modifier)
    } else {
        (after_d, 0)
    };

    let sides = sides_str
        .parse::<u32>()
        .map_err(|_| format!("Invalid sides: {sides_str}"))?;
    if sides == 0 {
        return Err("Dice sides must be at least 1".into());
    }

    Ok(DiceNotation {
        count,
        sides,
        modifier,
    })
}

/// Roll dice according to parsed notation. Returns (individual rolls, total).
pub fn execute_dice_roll(notation: &DiceNotation) -> (Vec<u32>, i32) {
    let mut rng = rand::rng();
    let rolls: Vec<u32> = (0..notation.count)
        .map(|_| rng.random_range(1..=notation.sides))
        .collect();
    let sum = rolls
        .iter()
        .map(|&r| i32::try_from(r).unwrap_or(i32::MAX))
        .fold(notation.modifier, i32::saturating_add);
    (rolls, sum)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_standard_notation() {
        let r = parse_dice_notation("2d6").unwrap();
        assert_eq!(
            r,
            DiceNotation {
                count: 2,
                sides: 6,
                modifier: 0
            }
        );
    }

    #[test]
    fn parse_with_positive_modifier() {
        let r = parse_dice_notation("1d20+5").unwrap();
        assert_eq!(
            r,
            DiceNotation {
                count: 1,
                sides: 20,
                modifier: 5
            }
        );
    }

    #[test]
    fn parse_with_negative_modifier() {
        let r = parse_dice_notation("4d6-1").unwrap();
        assert_eq!(
            r,
            DiceNotation {
                count: 4,
                sides: 6,
                modifier: -1
            }
        );
    }

    #[test]
    fn parse_implicit_count() {
        let r = parse_dice_notation("d8").unwrap();
        assert_eq!(
            r,
            DiceNotation {
                count: 1,
                sides: 8,
                modifier: 0
            }
        );
    }

    #[test]
    fn parse_rejects_missing_d() {
        assert!(parse_dice_notation("26").is_err());
    }

    #[test]
    fn parse_rejects_zero_count() {
        assert!(parse_dice_notation("0d6").is_err());
    }

    #[test]
    fn parse_rejects_zero_sides() {
        assert!(parse_dice_notation("2d0").is_err());
    }

    #[test]
    fn dice_roll_within_range() {
        let notation = DiceNotation {
            count: 2,
            sides: 6,
            modifier: 3,
        };
        for _ in 0..100 {
            let (rolls, total) = execute_dice_roll(&notation);
            assert_eq!(rolls.len(), 2);
            for &r in &rolls {
                assert!((1..=6).contains(&r));
            }
            assert!((5..=15).contains(&total));
        }
    }

    #[test]
    fn ordinal_suffix_cases() {
        assert_eq!(ordinal_suffix(1), "st");
        assert_eq!(ordinal_suffix(2), "nd");
        assert_eq!(ordinal_suffix(3), "rd");
        assert_eq!(ordinal_suffix(4), "th");
        assert_eq!(ordinal_suffix(11), "th");
        assert_eq!(ordinal_suffix(12), "th");
        assert_eq!(ordinal_suffix(13), "th");
        assert_eq!(ordinal_suffix(21), "st");
        assert_eq!(ordinal_suffix(22), "nd");
        assert_eq!(ordinal_suffix(23), "rd");
        assert_eq!(ordinal_suffix(31), "st");
    }

    #[test]
    fn handle_roll_dice_valid() {
        let result = handle_roll_dice(&json!({"notation": "2d6"})).unwrap();
        assert_eq!(result["notation"], "2d6");
        assert!(result["rolls"].is_array());
        assert_eq!(result["rolls"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn handle_roll_dice_missing_notation() {
        let result = handle_roll_dice(&json!({}));
        assert!(result.is_err());
    }
}
