use super::{ToolCategory, ToolContext, ToolDef, ToolError};
use crate::llm::types::ImageGenerateParams;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use tracing::info;

pub fn tool_defs() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "generate_image",
        description: crate::include_prompt!("../../prompts/tools/images/generate_image.md"),
        parameters: json!({
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Text prompt for image generation."
                },
                "size": {
                    "type": "string",
                    "description": "Image dimensions (e.g. '1024x1024').",
                    "default": "1024x1024"
                },
                "caption": {
                    "type": "string",
                    "description": "Optional caption to send with the generated image."
                }
            },
            "required": ["prompt"]
        }),
        category: ToolCategory::Other,
    }]
}

pub async fn handle_generate_image(
    input: Value,
    ctx: &dyn ToolContext,
) -> Result<Value, ToolError> {
    let prompt = input
        .get("prompt")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ToolError::InvalidArgs("missing 'prompt' field".to_owned()))?;

    let client = ctx
        .llm_client()
        .ok_or_else(|| ToolError::Io("image generation not available: no LLM client".into()))?;
    let config = ctx
        .image_gen_config()
        .ok_or_else(|| ToolError::Io("no [image_generation] profile configured".into()))?;

    let size = input
        .get("size")
        .and_then(|v| v.as_str())
        .unwrap_or(&config.size);
    let caption = input
        .get("caption")
        .and_then(|v| v.as_str())
        .map(str::to_owned);

    let params = ImageGenerateParams {
        provider_key: &config.provider,
        model: &config.model_id,
        api_key: &config.api_key,
        base_url: config.base_url.as_deref(),
        prompt,
        size: Some(size),
        quality: config.quality.as_deref(),
        aspect_ratio: config.aspect_ratio.as_deref(),
        image_size: config.image_size.as_deref(),
    };
    let result = client
        .image_generate(&params)
        .await
        .map_err(|e| ToolError::Http(format!("image generation failed: {e}")))?;

    info!(
        url_len = result.url.len(),
        revised_prompt = %result.revised_prompt,
        timing_ms = result.timing.total_ms,
        "Image generated via shore-llm"
    );

    let (image_bytes, extension) = if result.url.starts_with("data:") {
        decode_data_url(&result.url)?
    } else {
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_mins(1))
            .build()
            .map_err(|e| ToolError::Http(format!("failed to create HTTP client: {e}")))?;

        let bytes = http_client
            .get(&result.url)
            .send()
            .await
            .map_err(|e| ToolError::Http(format!("failed to download image: {e}")))?
            .bytes()
            .await
            .map_err(|e| ToolError::Http(format!("failed to read image bytes: {e}")))?;

        (bytes.to_vec(), "png".to_owned())
    };

    let image_dir = std::path::Path::new(ctx.image_dir());
    let generated_dir = image_dir.join("generated");
    std::fs::create_dir_all(&generated_dir)
        .map_err(|e| ToolError::Io(format!("failed to create directory: {e}")))?;

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let filename = format!("{timestamp}.{extension}");
    let save_path = generated_dir.join(&filename);

    std::fs::write(&save_path, &image_bytes)
        .map_err(|e| ToolError::Io(format!("failed to save image: {e}")))?;

    Ok(json!({
        "path": save_path.to_string_lossy(),
        "caption": caption,
        "revised_prompt": result.revised_prompt,
        "timing_ms": result.timing.total_ms,
        "sent": true,
    }))
}

fn decode_data_url(url: &str) -> Result<(Vec<u8>, String), ToolError> {
    let rest = url
        .strip_prefix("data:image/")
        .ok_or_else(|| ToolError::Io("data URL is not an image".into()))?;

    let (mime_subtype, b64_data) = rest
        .split_once(";base64,")
        .ok_or_else(|| ToolError::Io("data URL missing ;base64, separator".into()))?;

    let extension = match mime_subtype {
        "jpeg" => "jpg",
        other => other,
    }
    .to_owned();

    let bytes = BASE64
        .decode(b64_data)
        .map_err(|e| ToolError::Io(format!("failed to decode base64 image: {e}")))?;

    Ok((bytes, extension))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestToolContext;

    #[test]
    fn test_image_tool_defs() {
        let defs = tool_defs();
        assert_eq!(defs.len(), 1);
        let names: Vec<&str> = defs.iter().map(|d| d.name).collect();
        assert!(names.contains(&"generate_image"));
    }

    #[tokio::test]
    async fn test_generate_image_no_config() {
        let ctx = TestToolContext::new().with_image_dir("/tmp");
        let result =
            handle_generate_image(json!({"prompt": "a cat", "size": "512x512"}), &ctx).await;
        assert!(matches!(result, Err(ToolError::Io(_))));
    }

    #[test]
    fn test_decode_data_url_png() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let raw = b"fake png bytes";
        let encoded = STANDARD.encode(raw);
        let url = format!("data:image/png;base64,{encoded}");

        let (bytes, ext) = decode_data_url(&url).unwrap();
        assert_eq!(bytes, raw);
        assert_eq!(ext, "png");
    }

    #[test]
    fn test_decode_data_url_jpeg() {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let raw = b"fake jpeg bytes";
        let encoded = STANDARD.encode(raw);
        let url = format!("data:image/jpeg;base64,{encoded}");

        let (bytes, ext) = decode_data_url(&url).unwrap();
        assert_eq!(bytes, raw);
        assert_eq!(ext, "jpg");
    }

    #[test]
    fn test_decode_data_url_not_image() {
        let url = "data:text/plain;base64,aGVsbG8=";
        let result = decode_data_url(url);
        assert!(matches!(result, Err(ToolError::Io(_))));
    }
}
