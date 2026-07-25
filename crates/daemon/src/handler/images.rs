//! Image processing helpers for the handler pipeline.
//!
//! Contains MIME detection, content building, image ingestion (base64 uploads
//! and legacy filesystem paths), and wire-embedding of image data.

use base64::Engine as _;
use serde_json::{json, Value};
use shore_common::protocol::types::{ContentBlock, ImageRef, Message};
use tracing::{info, warn};

/// Detect MIME type from file extension.
pub(crate) fn media_type_for_path(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Sniff an image media type from magic bytes (PNG/JPEG/GIF/WebP).
pub(crate) fn sniff_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP".as_slice()) {
        return Some("image/webp");
    }
    None
}

/// Map a known image media type to its canonical file extension.
///
/// Tolerates case and parameters in declared values off the wire
/// (`Image/PNG; charset=binary`).
fn extension_for_media_type(media_type: &str) -> Option<&'static str> {
    let essence = media_type
        .split(';')
        .next()
        .unwrap_or(media_type)
        .trim()
        .to_ascii_lowercase();
    match essence.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// Reduce a client-supplied filename to a safe single path component.
///
/// Upload filenames come straight off the wire (e.g. a Matrix event body), so
/// they may carry path separators or be empty; joined into the attachments
/// dir unchecked they could escape it or fail the write.
fn sanitize_filename(name: &str) -> String {
    let base: String = name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(name)
        .chars()
        .filter(|c| *c != '\0')
        .collect();
    if base.is_empty() || base == "." || base == ".." {
        "image".to_owned()
    } else {
        base
    }
}

/// Choose the attachment file name for incoming image bytes.
///
/// Keeps a recognized extension as-is; otherwise appends one derived from the
/// bytes (magic sniff) or the client-declared media type. Everything
/// downstream (LLM block encoding, resize cache, TS sidecar) keys the media
/// type off the saved extension, so an upload without one — routine for
/// Matrix, where media is content-addressed and the mime type travels
/// out-of-band — would otherwise be silently dropped from LLM requests.
fn attachment_file_name(filename: &str, declared_mime: Option<&str>, bytes: &[u8]) -> String {
    let safe = sanitize_filename(filename);
    if media_type_for_path(&safe).is_some() {
        return safe;
    }
    let extension = sniff_media_type(bytes)
        .and_then(extension_for_media_type)
        .or_else(|| declared_mime.and_then(extension_for_media_type));
    if let Some(ext) = extension {
        format!("{safe}.{ext}")
    } else {
        warn!(
            filename = %safe,
            "Could not determine image type from bytes, declared mime, or extension; \
             the LLM pipeline will skip this attachment"
        );
        safe
    }
}

/// Build a `content` value for an LLM message.
///
/// If `images` is non-empty, returns a JSON array containing image blocks
/// (base64-encoded, resized if over `max_image_size`) followed by a text block.
/// Otherwise returns a plain string. Pass `0` for `max_image_size` to disable resizing.
pub(crate) fn build_content(
    text: &str,
    images: &[ImageRef],
    max_image_size: u64,
    cache_dir: &std::path::Path,
) -> Value {
    if images.is_empty() {
        return json!(text);
    }

    let mut blocks: Vec<Value> = Vec::with_capacity(images.len().saturating_add(1));

    for img in images {
        let Some(media_type) = media_type_for_path(&img.path) else {
            warn!(path = %img.path, "Skipping image with unsupported extension");
            continue;
        };
        match std::fs::read(&img.path) {
            Ok(bytes) => {
                let (final_bytes, final_media_type) = if let Some((resized, mt)) =
                    super::resize::cached_resize(
                        &img.path,
                        &bytes,
                        media_type,
                        max_image_size,
                        cache_dir,
                    ) {
                    (resized, mt)
                } else {
                    (bytes, media_type)
                };
                let encoded = base64::engine::general_purpose::STANDARD.encode(&final_bytes);
                blocks.push(json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": final_media_type,
                        "data": encoded,
                    }
                }));
            }
            Err(e) => {
                warn!(path = %img.path, error = %e, "Failed to read image file");
            }
        }
    }

    // Only append a text block when there is actual text. An image-only
    // message (empty text) must not carry a blank `{"type":"text","text":""}`
    // block — Anthropic rejects it with "text content blocks must be
    // non-empty", failing the whole request.
    if !text.trim().is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }

    // If every image failed to encode and there was no text, fall back to the
    // string-content shape rather than emitting an empty content array (which
    // the API also rejects).
    if blocks.is_empty() {
        return json!(text);
    }
    json!(blocks)
}

/// Ingest incoming images to durable attachments/ directory.
///
/// Prefers `image_data` (base64-encoded uploads from new clients) over
/// `image_paths` (legacy path-based, same-machine only).
/// Returns (persisted ImageRefs, model-facing ContentBlocks).
///
/// Uploaded attachment paths are intentionally kept out of model-facing
/// content. The LLM receives image blocks via the returned ImageRefs instead.
pub(super) fn ingest_images(
    data_dir: &std::path::Path,
    char_name: &str,
    image_paths: &[String],
    image_data: &[shore_common::protocol::client_msg::ImageUpload],
) -> (Vec<ImageRef>, Vec<ContentBlock>) {
    use shore_common::config::character_data_dir;

    let attachments_dir = character_data_dir(data_dir, char_name)
        .join("images")
        .join("attachments");
    let mut images: Vec<ImageRef> =
        Vec::with_capacity(image_data.len().saturating_add(image_paths.len()));

    // Preferred path: base64-encoded uploads (works across machines).
    for upload in image_data {
        if let Some(image_ref) = ingest_upload(&attachments_dir, upload) {
            images.push(image_ref);
        }
    }

    // Legacy fallback: copy from filesystem paths (same-machine only).
    if image_data.is_empty() {
        for src_path_str in image_paths {
            if let Some(image_ref) = ingest_legacy_path(&attachments_dir, src_path_str) {
                images.push(image_ref);
            }
        }
    }

    (images, Vec::new())
}

/// Decode and persist one base64 upload. `None` = skipped (logged).
fn ingest_upload(
    attachments_dir: &std::path::Path,
    upload: &shore_common::protocol::client_msg::ImageUpload,
) -> Option<ImageRef> {
    use base64::Engine;

    let bytes = match base64::engine::general_purpose::STANDARD.decode(&upload.data) {
        Ok(b) => b,
        Err(e) => {
            warn!(filename = %upload.filename, error = %e, "Failed to decode base64 image data");
            return None;
        }
    };
    save_attachment(
        attachments_dir,
        &upload.filename,
        upload.mime_type.as_deref(),
        &bytes,
    )
}

/// Copy one legacy filesystem path into attachments. Reads instead of
/// `fs::copy` so an extension-less source still gets a usable extension from
/// its magic bytes. Falls back to referencing the original path when the
/// copy fails but the source exists.
fn ingest_legacy_path(attachments_dir: &std::path::Path, src_path_str: &str) -> Option<ImageRef> {
    let src_path = std::path::Path::new(src_path_str);
    if !src_path.exists() {
        warn!(path = %src_path_str, "Skipping non-existent image");
        return None;
    }
    let original_name = src_path
        .file_name()
        .map_or_else(|| "image".to_owned(), |n| n.to_string_lossy().to_string());
    let fallback = || {
        Some(ImageRef {
            path: src_path_str.to_owned(),
            caption: None,
            data: None,
        })
    };
    match std::fs::read(src_path) {
        Ok(bytes) => {
            save_attachment(attachments_dir, &original_name, None, &bytes).or_else(fallback)
        }
        Err(e) => {
            warn!(src = %src_path_str, error = %e, "Failed to read image for attachments copy");
            fallback()
        }
    }
}

/// Write image bytes into the attachments dir under a timestamped,
/// extension-corrected name. Returns the saved ImageRef, or `None` on failure.
fn save_attachment(
    attachments_dir: &std::path::Path,
    source_name: &str,
    declared_mime: Option<&str>,
    bytes: &[u8],
) -> Option<ImageRef> {
    use std::io::Write as _;

    if let Err(e) = std::fs::create_dir_all(attachments_dir) {
        warn!(error = %e, "Failed to create attachments directory");
        return None;
    }
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let dest_name = format!(
        "{timestamp}_{}",
        attachment_file_name(source_name, declared_mime, bytes)
    );
    let (dest_path, mut file) = match create_attachment_file(attachments_dir, &dest_name) {
        Ok(pair) => pair,
        Err(e) => {
            warn!(source = %source_name, error = %e, "Failed to create attachment file");
            return None;
        }
    };
    if let Err(e) = file.write_all(bytes) {
        warn!(source = %source_name, error = %e, "Failed to write image to attachments");
        let _ignored = std::fs::remove_file(&dest_path);
        return None;
    }
    info!(
        source = %source_name,
        dest = %dest_path.display(),
        "Saved incoming image to attachments"
    );
    Some(ImageRef {
        path: dest_path.to_string_lossy().to_string(),
        caption: None,
        data: None,
    })
}

/// Atomically claim a destination file for an attachment.
///
/// The timestamp in attachment names is second-granular, so two uploads
/// sharing a filename in the same second would otherwise overwrite each
/// other. `create_new` makes the claim atomic; on collision the name is
/// de-duplicated with `_1`, `_2`, … before the extension.
fn create_attachment_file(
    attachments_dir: &std::path::Path,
    file_name: &str,
) -> std::io::Result<(std::path::PathBuf, std::fs::File)> {
    use std::io::ErrorKind;

    let (stem, dot_ext) = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_owned(), format!(".{ext}")),
        Some(_) | None => (file_name.to_owned(), String::new()),
    };
    for attempt in 0_u32..1000 {
        let candidate = if attempt == 0 {
            file_name.to_owned()
        } else {
            format!("{stem}_{attempt}{dot_ext}")
        };
        let path = attachments_dir.join(&candidate);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((path, file)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::new(
        ErrorKind::AlreadyExists,
        format!("could not find a free attachment name for {file_name}"),
    ))
}

/// Populate the `data` field on ImageRefs by reading and base64-encoding files.
/// Called before sending Messages over the wire so clients can display images
/// without needing filesystem access to the server's paths.
pub(crate) fn embed_image_data(images: &mut [ImageRef]) {
    for img in images {
        if img.data.is_some() {
            continue;
        }
        if let Some(data) = image_data_for_path(&img.path) {
            img.data = Some(data);
        }
    }
}

/// Populate `data` on every image in a message and its alternate responses.
pub(crate) fn embed_message_image_data(message: &mut Message) {
    embed_image_data(&mut message.images);
    for alt in &mut message.alternatives {
        embed_image_data(&mut alt.images);
    }
}

/// Populate `data` on every image in a message slice before SWP transmission.
pub(crate) fn embed_messages_image_data(messages: &mut [Message]) {
    for message in messages {
        embed_message_image_data(message);
    }
}

/// Read and base64-encode an image path for SWP transmission.
pub(crate) fn image_data_for_path(path: &str) -> Option<String> {
    match std::fs::read(path) {
        Ok(bytes) => Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        Err(e) => {
            warn!(path = %path, error = %e, "Failed to read image for wire embedding");
            None
        }
    }
}

/// Encode a single image to a JSON block for the LLM API, resizing if needed.
pub(crate) fn encode_image_block(
    img: &ImageRef,
    max_image_size: u64,
    cache_dir: &std::path::Path,
) -> Option<Value> {
    let media_type = media_type_for_path(&img.path)?;
    match std::fs::read(&img.path) {
        Ok(bytes) => {
            let (final_bytes, final_media_type) = if let Some((resized, mt)) =
                super::resize::cached_resize(
                    &img.path,
                    &bytes,
                    media_type,
                    max_image_size,
                    cache_dir,
                ) {
                (resized, mt)
            } else {
                (bytes, media_type)
            };
            let encoded = base64::engine::general_purpose::STANDARD.encode(&final_bytes);
            Some(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": final_media_type,
                    "data": encoded,
                }
            }))
        }
        Err(e) => {
            warn!(path = %img.path, error = %e, "Failed to read image file for LLM");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD;
    use shore_common::protocol::client_msg::ImageUpload;

    /// Create a valid JPEG image with pseudo-random pixels (high entropy, resists compression).
    ///
    /// Pseudo-random pixels prevent JPEG/PNG from compressing the image to near-zero,
    /// ensuring the resulting file is large enough for the resize tests to be meaningful.
    fn make_noisy_jpeg(width: u32, height: u32) -> Vec<u8> {
        let len =
            usize::try_from(width.saturating_mul(height).saturating_mul(3)).unwrap_or(usize::MAX);
        let mut pixels = vec![0_u8; len];
        // Simple LCG to fill with pseudo-random values without pulling in rand.
        let mut state: u64 = 0xdead_beef_cafe_babe;
        for byte in &mut pixels {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            *byte = u8::try_from((state >> 33) & 0xff).unwrap_or_default();
        }
        let img = image::RgbImage::from_raw(width, height, pixels).unwrap();
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Jpeg)
            .unwrap();
        buf
    }

    /// Create a valid JPEG image of the given dimensions filled with a solid color.
    fn make_jpeg(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(width, height, image::Rgb([128, 64, 200]));
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Jpeg)
            .unwrap();
        buf
    }

    fn assert_no_path_instruction_blocks(content_blocks: &[ContentBlock], paths: &[&str]) {
        for block in content_blocks {
            let ContentBlock::Text { text } = block else {
                continue;
            };
            assert!(
                !text.contains("Attached image saved as"),
                "unexpected saved-path annotation: {text}"
            );
            assert!(
                !text.contains("reference this image"),
                "unexpected image reference instruction: {text}"
            );
            assert!(
                !text.contains("saved path"),
                "unexpected saved path instruction: {text}"
            );
            for path in paths {
                assert!(
                    !text.contains(path),
                    "unexpected attachment path {path:?} in model-facing text: {text}"
                );
            }
        }
    }

    // ── ingest_images ──────────────────────────────────────────────────

    #[test]
    fn ingest_images_saves_uploaded_image_without_model_facing_path_text() {
        let tmp = tempfile::TempDir::new().unwrap();
        let jpeg = make_jpeg(16, 16);
        let upload = ImageUpload {
            filename: "photo.jpg".to_owned(),
            data: STANDARD.encode(&jpeg),
            mime_type: None,
        };

        let (images, content_blocks) = ingest_images(tmp.path(), "Alice", &[], &[upload]);

        assert_eq!(images.len(), 1);
        assert!(std::path::Path::new(&images[0].path).exists());
        assert!(images[0].path.ends_with("photo.jpg"));
        assert!(content_blocks.is_empty());
        assert_no_path_instruction_blocks(&content_blocks, &[&images[0].path, "attachments/"]);
    }

    #[test]
    fn ingest_images_copies_legacy_path_without_model_facing_path_text() {
        let tmp = tempfile::TempDir::new().unwrap();
        let src_path = tmp.path().join("legacy.jpg");
        std::fs::write(&src_path, make_jpeg(16, 16)).unwrap();
        let src_path_str = src_path.to_string_lossy().to_string();

        let (images, content_blocks) = ingest_images(
            tmp.path(),
            "Alice",
            std::slice::from_ref(&src_path_str),
            &[],
        );

        assert_eq!(images.len(), 1);
        assert!(std::path::Path::new(&images[0].path).exists());
        assert_ne!(images[0].path, src_path_str);
        assert!(images[0].path.ends_with("legacy.jpg"));
        assert!(content_blocks.is_empty());
        assert_no_path_instruction_blocks(
            &content_blocks,
            &[&images[0].path, &src_path_str, "attachments/"],
        );
    }

    #[test]
    fn ingest_images_appends_sniffed_extension_for_extensionless_upload() {
        let tmp = tempfile::TempDir::new().unwrap();
        let jpeg = make_jpeg(16, 16);
        // Matrix-style upload: content-addressed name, no extension, no mime.
        let upload = ImageUpload {
            filename: "pasted_media_abc123".to_owned(),
            data: STANDARD.encode(&jpeg),
            mime_type: None,
        };

        let (images, _blocks) = ingest_images(tmp.path(), "Alice", &[], &[upload]);

        assert_eq!(images.len(), 1);
        assert!(std::path::Path::new(&images[0].path).exists());
        assert!(
            images[0].path.ends_with("pasted_media_abc123.jpg"),
            "expected sniffed .jpg extension, got {}",
            images[0].path
        );
        assert_eq!(media_type_for_path(&images[0].path), Some("image/jpeg"));
    }

    #[test]
    fn ingest_images_uses_declared_mime_when_bytes_unrecognized() {
        let tmp = tempfile::TempDir::new().unwrap();
        let upload = ImageUpload {
            filename: "snapshot".to_owned(),
            data: STANDARD.encode(b"not really an image"),
            mime_type: Some("image/png".to_owned()),
        };

        let (images, _blocks) = ingest_images(tmp.path(), "Alice", &[], &[upload]);

        assert_eq!(images.len(), 1);
        assert!(
            images[0].path.ends_with("snapshot.png"),
            "expected declared-mime .png extension, got {}",
            images[0].path
        );
    }

    #[test]
    fn ingest_images_sanitizes_path_traversal_filename() {
        let tmp = tempfile::TempDir::new().unwrap();
        let jpeg = make_jpeg(16, 16);
        let upload = ImageUpload {
            filename: "../../escape.jpg".to_owned(),
            data: STANDARD.encode(&jpeg),
            mime_type: None,
        };

        let (images, _blocks) = ingest_images(tmp.path(), "Alice", &[], &[upload]);

        assert_eq!(images.len(), 1);
        let saved = std::path::Path::new(&images[0].path);
        assert!(saved.exists());
        assert!(images[0].path.ends_with("escape.jpg"));
        let attachments_dir = shore_common::config::character_data_dir(tmp.path(), "Alice")
            .join("images")
            .join("attachments");
        assert_eq!(
            saved.parent().unwrap().canonicalize().unwrap(),
            attachments_dir.canonicalize().unwrap(),
            "sanitized upload must land inside the attachments dir"
        );
    }

    #[test]
    fn ingest_images_legacy_path_gets_sniffed_extension() {
        let tmp = tempfile::TempDir::new().unwrap();
        let src_path = tmp.path().join("legacy_no_extension");
        std::fs::write(&src_path, make_jpeg(16, 16)).unwrap();
        let src_path_str = src_path.to_string_lossy().to_string();

        let (images, _blocks) = ingest_images(
            tmp.path(),
            "Alice",
            std::slice::from_ref(&src_path_str),
            &[],
        );

        assert_eq!(images.len(), 1);
        assert!(std::path::Path::new(&images[0].path).exists());
        assert!(
            images[0].path.ends_with("legacy_no_extension.jpg"),
            "expected sniffed .jpg extension, got {}",
            images[0].path
        );
    }

    #[test]
    fn ingest_images_normalizes_declared_mime_case_and_parameters() {
        let tmp = tempfile::TempDir::new().unwrap();
        let upload = ImageUpload {
            filename: "snapshot".to_owned(),
            data: STANDARD.encode(b"not really an image"),
            mime_type: Some("Image/PNG; charset=binary".to_owned()),
        };

        let (images, _blocks) = ingest_images(tmp.path(), "Alice", &[], &[upload]);

        assert_eq!(images.len(), 1);
        assert!(
            images[0].path.ends_with("snapshot.png"),
            "expected normalized declared-mime .png extension, got {}",
            images[0].path
        );
    }

    #[test]
    fn ingest_images_deduplicates_same_second_filename_collisions() {
        let tmp = tempfile::TempDir::new().unwrap();
        let jpeg = make_jpeg(16, 16);
        let upload = ImageUpload {
            filename: "photo.jpg".to_owned(),
            data: STANDARD.encode(&jpeg),
            mime_type: None,
        };
        let uploads = vec![upload.clone(), upload.clone(), upload];

        let (images, _blocks) = ingest_images(tmp.path(), "Alice", &[], &uploads);

        assert_eq!(images.len(), 3);
        let mut paths: Vec<&str> = images.iter().map(|i| i.path.as_str()).collect();
        paths.sort_unstable();
        paths.dedup();
        assert_eq!(paths.len(), 3, "colliding uploads must get distinct paths");
        for img in &images {
            let saved = std::path::Path::new(&img.path);
            assert!(saved.exists());
            assert_eq!(
                std::fs::read(saved).unwrap(),
                jpeg,
                "every de-duplicated file must hold the full image bytes"
            );
            assert_eq!(media_type_for_path(&img.path), Some("image/jpeg"));
        }
    }

    #[test]
    fn extension_for_media_type_normalizes_input() {
        assert_eq!(extension_for_media_type("image/png"), Some("png"));
        assert_eq!(extension_for_media_type("Image/JPEG"), Some("jpg"));
        assert_eq!(
            extension_for_media_type(" image/webp ; q=0.8"),
            Some("webp")
        );
        assert_eq!(extension_for_media_type("text/plain"), None);
    }

    #[test]
    fn sniff_media_type_detects_known_formats() {
        assert_eq!(
            sniff_media_type(b"\x89PNG\r\n\x1a\n____"),
            Some("image/png")
        );
        assert_eq!(
            sniff_media_type(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_media_type(b"GIF89a______"), Some("image/gif"));
        assert_eq!(
            sniff_media_type(b"RIFF\x00\x00\x00\x00WEBP"),
            Some("image/webp")
        );
        assert_eq!(sniff_media_type(b"RIFF\x00\x00\x00\x00WAVE"), None);
        assert_eq!(sniff_media_type(b"plain text"), None);
        assert_eq!(sniff_media_type(b""), None);
    }

    #[test]
    fn embed_image_data_reads_files_for_wire_transfer() {
        let tmp = tempfile::TempDir::new().unwrap();
        let img_path = tmp.path().join("wire.jpg");
        let bytes = make_jpeg(8, 8);
        std::fs::write(&img_path, &bytes).unwrap();

        let encoded = image_data_for_path(img_path.to_str().unwrap()).unwrap();
        assert_eq!(STANDARD.decode(encoded).unwrap(), bytes);
    }

    #[test]
    fn embed_message_image_data_includes_alternatives() {
        use shore_common::protocol::types::{ContentBlock, ImageRef, MessageAlternative, Role};

        let tmp = tempfile::TempDir::new().unwrap();
        let top_path = tmp.path().join("top.jpg");
        let alt_path = tmp.path().join("alt.jpg");
        let top_bytes = make_jpeg(8, 8);
        let alt_bytes = make_jpeg(9, 9);
        std::fs::write(&top_path, &top_bytes).unwrap();
        std::fs::write(&alt_path, &alt_bytes).unwrap();

        let mut message = Message {
            msg_id: "m1".into(),
            origin: None,
            role: Role::Assistant,
            content: "hello".into(),
            images: vec![ImageRef {
                path: top_path.to_string_lossy().to_string(),
                caption: None,
                data: None,
            }],
            content_blocks: vec![ContentBlock::Text {
                text: "hello".into(),
            }],
            alt_index: None,
            alt_count: None,
            alternatives: vec![MessageAlternative {
                content: "alt".into(),
                images: vec![ImageRef {
                    path: alt_path.to_string_lossy().to_string(),
                    caption: None,
                    data: None,
                }],
                content_blocks: vec![],
                timestamp: "t".into(),
                provider_key: None,
                model: None,
            }],
            timestamp: "t".into(),
            provider_key: None,
            model: None,
        };

        embed_message_image_data(&mut message);

        assert_eq!(
            STANDARD
                .decode(message.images[0].data.as_deref().unwrap())
                .unwrap(),
            top_bytes
        );
        assert_eq!(
            STANDARD
                .decode(message.alternatives[0].images[0].data.as_deref().unwrap())
                .unwrap(),
            alt_bytes
        );
    }

    /// Create a valid PNG image with pseudo-random pixels (high entropy).
    fn make_noisy_png(width: u32, height: u32) -> Vec<u8> {
        let len =
            usize::try_from(width.saturating_mul(height).saturating_mul(3)).unwrap_or(usize::MAX);
        let mut pixels = vec![0_u8; len];
        let mut state: u64 = 0xcafe_f00d_1234_5678;
        for byte in &mut pixels {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            *byte = u8::try_from((state >> 33) & 0xff).unwrap_or_default();
        }
        let img = image::RgbImage::from_raw(width, height, pixels).unwrap();
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        buf
    }

    // ── build_content integration ──────────────────────────────────────

    #[test]
    fn build_content_resizes_oversized_image_on_disk() {
        use base64::Engine;
        use shore_common::protocol::types::ImageRef;

        let tmp = tempfile::TempDir::new().unwrap();

        // Write a large noisy JPEG to disk (~3-4 MB at 4000x3000).
        let big_jpeg = make_noisy_jpeg(4000, 3000);
        let img_path = tmp.path().join("big.jpg");
        std::fs::write(&img_path, &big_jpeg).unwrap();
        let original_size = big_jpeg.len();
        assert!(
            original_size > 2_000_000,
            "Test image should exceed 2MB, got {original_size} bytes"
        );

        let images = vec![ImageRef {
            path: img_path.to_str().unwrap().to_owned(),
            caption: None,
            data: None,
        }];

        // Call build_content with a 2MB limit.
        let result = build_content("describe this", &images, 2_000_000, tmp.path());
        let blocks = result.as_array().expect("Should be a JSON array");
        assert_eq!(blocks.len(), 2, "image block + text block");

        // Image block should be resized JPEG.
        assert_eq!(blocks[0]["type"], "image");
        assert_eq!(blocks[0]["source"]["type"], "base64");
        assert_eq!(blocks[0]["source"]["media_type"], "image/jpeg");

        // Decode the base64 and verify the raw bytes are under 2MB.
        let b64_data = blocks[0]["source"]["data"].as_str().unwrap();
        let decoded = STANDARD.decode(b64_data).unwrap();
        assert!(
            decoded.len() < 2_000_000,
            "Resized image should be under 2MB, got {} bytes (original was {})",
            decoded.len(),
            original_size
        );

        // Verify it's valid JPEG (starts with FFD8).
        assert_eq!(&decoded[..2], &[0xFF, 0xD8], "Should be valid JPEG");
    }

    #[test]
    fn build_content_does_not_resize_small_image() {
        use base64::Engine;
        use shore_common::protocol::types::ImageRef;

        let tmp = tempfile::TempDir::new().unwrap();

        // Write a small JPEG to disk.
        let small_jpeg = make_jpeg(200, 200);
        let img_path = tmp.path().join("small.jpg");
        std::fs::write(&img_path, &small_jpeg).unwrap();
        assert!(small_jpeg.len() < 2_000_000);

        let images = vec![ImageRef {
            path: img_path.to_str().unwrap().to_owned(),
            caption: None,
            data: None,
        }];

        let result = build_content("test", &images, 2_000_000, tmp.path());
        let blocks = result.as_array().unwrap();

        // Should still be image/jpeg (not re-encoded).
        assert_eq!(blocks[0]["source"]["media_type"], "image/jpeg");

        // Base64 should decode to the exact original bytes (no resize).
        let b64_data = blocks[0]["source"]["data"].as_str().unwrap();
        let decoded = STANDARD.decode(b64_data).unwrap();
        assert_eq!(
            decoded.len(),
            small_jpeg.len(),
            "Small image should pass through unchanged"
        );
    }

    #[test]
    fn build_content_resizes_oversized_png_to_jpeg() {
        use base64::Engine;
        use shore_common::protocol::types::ImageRef;

        let tmp = tempfile::TempDir::new().unwrap();

        // Write a large noisy PNG to disk.
        let big_png = make_noisy_png(3000, 2000);
        let img_path = tmp.path().join("big.png");
        std::fs::write(&img_path, &big_png).unwrap();
        let original_size = big_png.len();
        assert!(
            original_size > 2_000_000,
            "Test PNG should exceed 2MB, got {original_size} bytes"
        );

        let images = vec![ImageRef {
            path: img_path.to_str().unwrap().to_owned(),
            caption: None,
            data: None,
        }];

        let result = build_content("describe", &images, 2_000_000, tmp.path());
        let blocks = result.as_array().unwrap();

        // Should be converted to JPEG.
        assert_eq!(blocks[0]["source"]["media_type"], "image/jpeg");

        let b64_data = blocks[0]["source"]["data"].as_str().unwrap();
        let decoded = STANDARD.decode(b64_data).unwrap();
        assert!(
            decoded.len() < 2_000_000,
            "Resized PNG→JPEG should be under 2MB, got {} bytes",
            decoded.len()
        );
        assert_eq!(&decoded[..2], &[0xFF, 0xD8], "Should be valid JPEG");
    }
}
