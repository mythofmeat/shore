use super::{ToolCategory, ToolContext, ToolDef, ToolError};
use serde_json::{json, Value};
use std::time::Duration;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

pub fn tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "web_search",
            description: crate::include_prompt!("../../prompts/tools/web/web_search.md"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query."
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results to return.",
                        "default": 5
                    }
                },
                "required": ["query"]
            }),
            category: ToolCategory::Web,
        },
        ToolDef {
            name: "fetch_url",
            description: crate::include_prompt!("../../prompts/tools/web/fetch_url.md"),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to fetch."
                    }
                },
                "required": ["url"]
            }),
            category: ToolCategory::Web,
        },
    ]
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Handle `web_search` — search the web via Tavily API.
pub async fn handle_web_search(input: Value, ctx: &dyn ToolContext) -> Result<Value, ToolError> {
    let query = input
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidArgs("missing 'query' field".to_owned()))?;

    let search_cfg = ctx.search_config();

    let api_key = std::env::var(&search_cfg.api_key_env).map_err(|_| {
        ToolError::InvalidArgs(format!(
            "web_search requires the {} environment variable to be set",
            search_cfg.api_key_env
        ))
    })?;

    let max_results = input
        .get("max_results")
        .and_then(Value::as_u64)
        .unwrap_or(u64::from(search_cfg.result_limit));

    let body = json!({
        "api_key": api_key,
        "query": query,
        "max_results": max_results,
        "search_depth": search_cfg.search_depth,
        "include_answer": search_cfg.include_answer,
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| ToolError::Http(format!("failed to build HTTP client: {e}")))?;

    let resp = client
        .post("https://api.tavily.com/search")
        .json(&body)
        .send()
        .await
        .map_err(|e| ToolError::Http(format!("Tavily request failed: {e}")))?;

    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(ToolError::Http(format!(
            "Tavily API returned HTTP {status}: {err_body}"
        )));
    }

    let tavily_resp: Value = resp
        .json()
        .await
        .map_err(|e| ToolError::Http(format!("failed to parse Tavily response: {e}")))?;

    // Reshape results to a clean format.
    let results = tavily_resp
        .get("results")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|r| {
                    json!({
                        "title": r.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                        "url": r.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                        "content": r.get("content").and_then(|v| v.as_str()).unwrap_or(""),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut result = json!({
        "query": query,
        "results": results,
    });

    if let Some(answer) = tavily_resp.get("answer").and_then(|v| v.as_str()) {
        if let Some(obj) = result.as_object_mut() {
            let _ignored = obj.insert("answer".into(), json!(answer));
        }
    }

    Ok(result)
}

/// Maximum content length returned to the model (bytes, truncated on a char boundary).
const MAX_CONTENT_BYTES: usize = 50_000;

/// Handle `fetch_url` — fetch a webpage and extract readable text.
pub async fn handle_fetch_url(input: Value) -> Result<Value, ToolError> {
    let url = input
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidArgs("missing 'url' field".to_owned()))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("shore/2.0")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| ToolError::Http(format!("failed to build HTTP client: {e}")))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| ToolError::Http(format!("request failed: {e}")))?;

    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        return Err(ToolError::Http(format!("HTTP {status} for {url}")));
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown")
        .to_owned();

    let body = resp
        .text()
        .await
        .map_err(|e| ToolError::Http(format!("failed to read body: {e}")))?;

    let is_html = content_type.contains("html");
    let extracted = if is_html { strip_html(&body) } else { body };

    let truncated = extracted.len() > MAX_CONTENT_BYTES;
    let content = if truncated {
        let boundary = extracted.floor_char_boundary(MAX_CONTENT_BYTES);
        extracted.get(..boundary).unwrap_or(&extracted).to_owned()
    } else {
        extracted
    };

    Ok(json!({
        "url": url,
        "content_type": content_type,
        "content": content,
        "truncated": truncated,
    }))
}

/// Strip HTML tags and extract readable text content.
///
/// Removes `<script>`, `<style>`, and `<head>` blocks entirely, strips remaining
/// tags, decodes common HTML entities, and collapses whitespace.
#[expect(
    clippy::string_slice,
    reason = "byte offsets derive from find()/char-len() on `html` itself (see body comment), so every slice bound lands on a char boundary"
)]
fn strip_html(html: &str) -> String {
    // Phase 1: Remove script, style, and head blocks.
    //
    // We work entirely on the original `html` string using byte offsets
    // that are always derived from `html` itself.  Case-insensitive
    // comparisons use `str::to_ascii_lowercase()` on small slices rather
    // than a parallel lowercased copy (which can differ in byte length
    // for certain Unicode characters like ẞ → ß).
    let mut cleaned = String::with_capacity(html.len());
    let bytes = html.as_bytes();
    let mut i = 0;

    while i < html.len() {
        if bytes.get(i) == Some(&b'<') {
            // Check for blocks we want to skip entirely.
            // Compare case-insensitively against the original html slice.
            let remaining_lower = html[i..].to_ascii_lowercase();
            if let Some(tag) = ["script", "style", "head"]
                .iter()
                .find(|tag| remaining_lower.starts_with(&format!("<{tag}")))
            {
                // Find the closing tag (case-insensitive) in the original string.
                let close = format!("</{tag}");
                let rest_lower = html[i..].to_ascii_lowercase();
                if let Some(end_pos) = rest_lower.find(&close) {
                    // Skip past the closing tag's '>'
                    let after_close = i.saturating_add(end_pos).saturating_add(close.len());
                    if let Some(gt) = html[after_close..].find('>') {
                        i = after_close.saturating_add(gt).saturating_add(1);
                        continue;
                    }
                }
                // No closing tag found — skip to end
                break;
            }

            // Regular tag — skip it but add a space (block elements create breaks)
            if let Some(gt) = html[i..].find('>') {
                cleaned.push(' ');
                i = i.saturating_add(gt).saturating_add(1);
                continue;
            }
        }

        // Consume one character
        if let Some(ch) = html[i..].chars().next() {
            cleaned.push(ch);
            i = i.saturating_add(ch.len_utf8());
        } else {
            break;
        }
    }

    // Phase 2: Decode common HTML entities
    let decoded = cleaned
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&#x27;", "'")
        .replace("&#x2F;", "/");

    // Phase 3: Collapse whitespace
    let mut result = String::with_capacity(decoded.len());
    let mut prev_whitespace = false;
    for ch in decoded.chars() {
        if ch.is_whitespace() {
            if !prev_whitespace {
                result.push(' ');
            }
            prev_whitespace = true;
        } else {
            result.push(ch);
            prev_whitespace = false;
        }
    }

    result.trim().to_owned()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestToolContext;

    #[test]
    fn test_web_tool_defs() {
        let defs = tool_defs();
        assert_eq!(defs.len(), 2);

        let names: Vec<&str> = defs.iter().map(|d| d.name).collect();
        assert!(names.contains(&"web_search"));
        assert!(names.contains(&"fetch_url"));

        // All web tools should have Web category.
        for def in &defs {
            assert_eq!(def.category, ToolCategory::Web);
        }
    }

    #[tokio::test]
    async fn test_web_search_missing_query() {
        let ctx = TestToolContext::new();
        let result = handle_web_search(json!({}), &ctx).await;
        assert!(matches!(result, Err(ToolError::InvalidArgs(_))));
    }

    #[tokio::test]
    async fn test_web_search_no_api_key() {
        // With default config, TAVILY_API_KEY is unlikely to be set in test env.
        let ctx = TestToolContext::new();
        let result = handle_web_search(json!({"query": "rust programming"}), &ctx).await;
        assert!(matches!(result, Err(ToolError::InvalidArgs(_))));
        if let Err(ToolError::InvalidArgs(msg)) = result {
            assert!(
                msg.contains("TAVILY_API_KEY"),
                "error should name the env var: {msg}"
            );
        }
    }

    /// Live integration test — requires TAVILY_API_KEY env var.
    #[tokio::test]
    #[ignore = "live web search requires TAVILY_API_KEY and network access"]
    async fn test_web_search_live() {
        let ctx = TestToolContext::new();
        let result = handle_web_search(
            json!({"query": "Rust programming language", "max_results": 2}),
            &ctx,
        )
        .await
        .expect("live search should succeed");

        assert_eq!(result["query"], "Rust programming language");
        let results = result["results"]
            .as_array()
            .expect("results should be array");
        assert!(!results.is_empty(), "should have at least one result");
        // Each result should have title, url, content.
        for r in results {
            assert!(r["title"].as_str().is_some());
            assert!(r["url"].as_str().is_some());
            assert!(r["content"].as_str().is_some());
        }
    }

    #[tokio::test]
    async fn test_fetch_url_missing_url() {
        let result = handle_fetch_url(json!({})).await;
        assert!(matches!(result, Err(ToolError::InvalidArgs(_))));
    }

    #[test]
    fn test_strip_html_basic() {
        let html = "<html><body><h1>Hello</h1><p>World</p></body></html>";
        let text = strip_html(html);
        assert!(text.contains("Hello"));
        assert!(text.contains("World"));
        assert!(!text.contains("<h1>"));
    }

    #[test]
    fn test_strip_html_removes_script_and_style() {
        let html = r"<html><head><title>T</title></head><body>
            <script>var x = 1;</script>
            <style>.foo { color: red; }</style>
            <p>Visible text</p>
        </body></html>";
        let text = strip_html(html);
        assert!(text.contains("Visible text"));
        assert!(!text.contains("var x"));
        assert!(!text.contains("color: red"));
        assert!(!text.contains("<title>"));
    }

    #[test]
    fn test_strip_html_decodes_entities() {
        let html = "<p>A &amp; B &lt; C &gt; D &quot;E&quot;</p>";
        let text = strip_html(html);
        assert!(text.contains("A & B < C > D \"E\""));
    }

    #[test]
    fn test_strip_html_collapses_whitespace() {
        let html = "<p>  lots   of    spaces  </p>";
        let text = strip_html(html);
        // Should not have runs of multiple spaces
        assert!(!text.contains("  "));
    }

    /// `ẞ` (U+1E9E, 3 bytes) lowercases to `ß` (U+00DF, 2 bytes).
    /// When `to_lowercase()` shrinks the string, byte offsets from `html`
    /// exceed `lower_bytes.len()` → out-of-bounds panic.
    #[test]
    fn test_strip_html_unicode_lowercase_length_change() {
        // ẞ (3 bytes) → ß (2 bytes). After 10 ẞ chars:
        //   html  = 30 bytes of ẞ + 10 bytes of tag = 40 bytes
        //   lower = 20 bytes of ß + 10 bytes of tag = 30 bytes
        // At offset 30 in html, lower_bytes[30] is out of bounds.
        let html = format!("{}<b>x</b>", "ẞ".repeat(10));
        let result = strip_html(&html);
        // Should extract the text content without panicking.
        assert!(result.contains('x'));
    }
}
