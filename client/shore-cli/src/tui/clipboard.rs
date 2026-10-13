use std::io;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use image::{DynamicImage, ImageEncoder, ImageFormat};

const MAX_IMAGE_EDGE: u32 = 2000;
const MAX_IMAGE_BYTES: usize = 750_000;

#[derive(Debug)]
pub(crate) enum ClipboardError {
    NoImage,
    ClipboardUnavailable(String),
    WriteFailed(io::Error),
    InvalidImage(image::ImageError),
}

impl std::fmt::Display for ClipboardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClipboardError::NoImage => write!(f, "clipboard has no image"),
            ClipboardError::ClipboardUnavailable(e) => write!(f, "clipboard unavailable: {e}"),
            ClipboardError::WriteFailed(e) => write!(f, "failed to write paste temp: {e}"),
            ClipboardError::InvalidImage(e) => write!(f, "could not prepare clipboard image: {e}"),
        }
    }
}

impl std::error::Error for ClipboardError {}

fn prepare_image(bytes: &[u8]) -> image::ImageResult<(Vec<u8>, &'static str)> {
    let format = image::guess_format(bytes)?;
    let decoded = image::load_from_memory_with_format(bytes, format)?;
    let edge = decoded.width().max(decoded.height());
    if edge <= MAX_IMAGE_EDGE && bytes.len() <= MAX_IMAGE_BYTES {
        return Ok((
            bytes.to_vec(),
            format.extensions_str().first().copied().unwrap_or("png"),
        ));
    }
    let rgba = decoded.into_rgba8();
    let opaque = rgba.pixels().all(|pixel| pixel.0[3] == 255);
    let rgba_image = DynamicImage::ImageRgba8(rgba);
    let original = if opaque {
        DynamicImage::ImageRgb8(rgba_image.into_rgb8())
    } else {
        rgba_image
    };
    let mut size = edge.min(MAX_IMAGE_EDGE);
    loop {
        let resized = original.resize(size, size, image::imageops::FilterType::Lanczos3);
        let mut lossless = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut lossless,
            image::codecs::png::CompressionType::Default,
            image::codecs::png::FilterType::Adaptive,
        )
        .write_image(
            resized.as_bytes(),
            resized.width(),
            resized.height(),
            resized.color().into(),
        )?;
        if lossless.len() <= MAX_IMAGE_BYTES {
            return Ok((lossless, "png"));
        }
        let mut compressed = Vec::new();
        let suffix = if opaque {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut compressed, 85)
                .encode_image(&resized)?;
            "jpg"
        } else {
            resized.write_to(&mut io::Cursor::new(&mut compressed), ImageFormat::WebP)?;
            "webp"
        };
        if compressed.len() <= MAX_IMAGE_BYTES {
            return Ok((compressed, suffix));
        }
        size = size.saturating_mul(4).checked_div(5).unwrap_or(1).max(1);
    }
}

fn write_image_to_temp(bytes: &[u8]) -> Result<PathBuf, ClipboardError> {
    let (prepared, suffix) = prepare_image(bytes).map_err(ClipboardError::InvalidImage)?;
    let mut file = tempfile::Builder::new()
        .prefix("shore_paste_")
        .suffix(&format!(".{suffix}"))
        .tempfile()
        .map_err(ClipboardError::WriteFailed)?;
    file.write_all(&prepared)
        .map_err(ClipboardError::WriteFailed)?;
    let (_file, path) = file
        .keep()
        .map_err(|error| ClipboardError::WriteFailed(error.error))?;
    Ok(path)
}

pub(crate) async fn read_image_to_temp() -> Result<PathBuf, ClipboardError> {
    let read = tokio::time::timeout(
        std::time::Duration::from_millis(1500),
        tokio::task::spawn_blocking(read_image),
    )
    .await
    .map_err(|_| ClipboardError::ClipboardUnavailable("read timed out".into()))?;
    let bytes = read.map_err(|error| ClipboardError::ClipboardUnavailable(error.to_string()))??;
    tokio::task::spawn_blocking(move || write_image_to_temp(&bytes))
        .await
        .map_err(|error| ClipboardError::ClipboardUnavailable(error.to_string()))?
}

fn read_image() -> Result<Vec<u8>, ClipboardError> {
    #[cfg(target_os = "macos")]
    {
        let file = tempfile::Builder::new()
            .prefix("shore_clipboard_")
            .suffix(".png")
            .tempfile()
            .map_err(ClipboardError::WriteFailed)?;
        let path = file.path();
        let script = r#"on run argv
set outputFile to POSIX file (item 1 of argv)
try
    set imageData to the clipboard as «class PNGf»
on error
    error "clipboard has no PNG image"
end try
set fileRef to open for access outputFile with write permission
try
    set eof fileRef to 0
    write imageData to fileRef
    close access fileRef
on error errorMessage
    try
        close access fileRef
    end try
    error errorMessage
end try
end run"#;
        let status = Command::new("osascript")
            .args(["-e", script, "--"])
            .arg(path)
            .status()
            .map_err(|e| ClipboardError::ClipboardUnavailable(format!("osascript failed: {e}")))?;
        if !status.success() {
            return Err(ClipboardError::NoImage);
        }
        if std::fs::metadata(path).map_or(true, |metadata| metadata.len() == 0) {
            return Err(ClipboardError::NoImage);
        }
        std::fs::read(path).map_err(ClipboardError::WriteFailed)
    }

    #[cfg(not(target_os = "macos"))]
    {
        if std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return Err(ClipboardError::ClipboardUnavailable(
                "not a Wayland session".into(),
            ));
        }

        let output = Command::new("wl-paste")
            .args(["--type", "image/png", "--no-newline"])
            .output()
            .map_err(|e| {
                ClipboardError::ClipboardUnavailable(format!(
                    "wl-paste failed: {e} (install wl-clipboard)"
                ))
            })?;

        if !output.status.success() || output.stdout.is_empty() {
            return Err(ClipboardError::NoImage);
        }

        Ok(output.stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(image: &DynamicImage) -> Vec<u8> {
        let mut bytes = io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        bytes.into_inner()
    }

    fn noise(width: u32, height: u32, alpha: u8) -> DynamicImage {
        let mut state = 42_u32;
        DynamicImage::ImageRgba8(image::RgbaImage::from_fn(width, height, |_, _| {
            let mut pixel = [0, 0, 0, alpha];
            for channel in &mut pixel[..3] {
                state = state.wrapping_mul(1664525).wrapping_add(1013904223);
                *channel = state.to_be_bytes()[0];
            }
            image::Rgba(pixel)
        }))
    }

    #[test]
    fn opaque_clipboard_photos_upload_as_compact_jpegs() {
        use base64::Engine;
        let input = png(&noise(1000, 800, 255));
        assert!(input.len() > MAX_IMAGE_BYTES);
        let path = write_image_to_temp(&input).unwrap();
        let upload = shore_common::swp_client::read_image_upload(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(path).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(upload.data)
            .unwrap();
        assert!(upload.filename.ends_with(".jpg"));
        assert_eq!(image::guess_format(&bytes).unwrap(), ImageFormat::Jpeg);
        assert!(bytes.len() <= MAX_IMAGE_BYTES);
        assert!(bytes.len() < input.len().checked_div(2).unwrap());
        let image = image::load_from_memory(&bytes).unwrap();
        assert!(image.width() <= 1000);
        assert!(image.height() <= 800);
        assert_eq!(image.width() * 4, image.height() * 5);
    }

    #[test]
    fn wide_clipboard_images_resize_even_when_the_png_is_tiny() {
        let input = png(&DynamicImage::new_rgb8(4000, 1000));
        assert!(input.len() < MAX_IMAGE_BYTES);
        let (bytes, suffix) = prepare_image(&input).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height(), suffix), (2000, 500, "png"));
    }

    #[test]
    fn screenshot_detail_stays_lossless_when_compression_alone_fits() {
        let image = image::RgbImage::from_fn(1000, 300, |x, y| {
            image::Rgb(if x % 12 < 3 && y % 20 < 10 {
                [0; 3]
            } else {
                [255; 3]
            })
        });
        let mut input = Vec::new();
        image::codecs::png::PngEncoder::new_with_quality(
            &mut input,
            image::codecs::png::CompressionType::Uncompressed,
            image::codecs::png::FilterType::NoFilter,
        )
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
        assert!(input.len() > MAX_IMAGE_BYTES);
        let (bytes, suffix) = prepare_image(&input).unwrap();
        assert_eq!(suffix, "png");
        assert!(bytes.len() <= MAX_IMAGE_BYTES);
        assert_eq!(image::load_from_memory(&bytes).unwrap().into_rgb8(), image);
    }

    #[test]
    fn transparent_clipboard_images_keep_their_alpha_when_reduced() {
        let input = png(&noise(800, 600, 80));
        assert!(input.len() > MAX_IMAGE_BYTES);
        let (bytes, suffix) = prepare_image(&input).unwrap();
        assert_ne!(suffix, "jpg");
        assert!(bytes.len() <= MAX_IMAGE_BYTES);
        let image = image::load_from_memory(&bytes).unwrap().into_rgba8();
        assert!(image.width() <= 800);
        assert!(image.height() <= 600);
        assert!(image.pixels().all(|pixel| pixel.0[3] == 80));
    }

    #[test]
    fn invalid_clipboard_bytes_are_reported_before_creating_an_attachment() {
        assert!(matches!(
            write_image_to_temp(b"not an image"),
            Err(ClipboardError::InvalidImage(_))
        ));
    }

    #[test]
    fn temp_path_format() {
        let image = DynamicImage::new_rgb8(10, 10);
        let mut bytes = io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let p = write_image_to_temp(bytes.get_ref()).unwrap();
        let name = p.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("shore_paste_"), "name was {name}");
        assert_eq!(
            p.extension().and_then(std::ffi::OsStr::to_str),
            Some("png"),
            "name was {name}"
        );
        assert_eq!(p.parent().unwrap(), std::env::temp_dir().as_path());
        assert_eq!(std::fs::read(&p).unwrap(), *bytes.get_ref());
        std::fs::remove_file(p).unwrap();
    }
}
