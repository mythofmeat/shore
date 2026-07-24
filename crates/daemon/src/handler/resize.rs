//! Smart image resize with format awareness, dimension floors, and disk caching.
//!
//! Replaces the MVP single-pass resizer with:
//! - Alpha detection (transparent PNGs stay PNG, opaque images convert to JPEG)
//! - Quality-first strategy for images under 2048px
//! - Dimension estimation for larger images
//! - XDG disk cache to avoid re-encoding on every turn
//! - Async pre-warming via spawn_blocking

use crate::convert::{f64_to_u32_saturating, u64_to_f64, usize_to_f64, usize_to_u64};
use fast_image_resize as fir;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilterType, PngEncoder};
use image::{DynamicImage, ExtendedColorType, ImageEncoder};
use sha2::{Digest, Sha256};
use std::path::Path;
use tracing::{info, warn};

const DIMENSION_FLOOR: u32 = 2048;

pub(super) fn has_meaningful_alpha(img: &DynamicImage) -> bool {
    use image::DynamicImage::{ImageLumaA16, ImageLumaA8, ImageRgba16, ImageRgba32F, ImageRgba8};
    if let ImageRgba8(rgba) = img {
        rgba.pixels().any(|p| p[3] < 255)
    } else if let ImageRgba16(rgba) = img {
        rgba.pixels().any(|p| p[3] < 65535)
    } else if let ImageRgba32F(rgba) = img {
        rgba.pixels().any(|p| p[3] < 1.0)
    } else if let ImageLumaA8(la) = img {
        la.pixels().any(|p| p[1] < 255)
    } else if let ImageLumaA16(la) = img {
        la.pixels().any(|p| p[1] < 65535)
    } else {
        false
    }
}

pub(super) fn smart_resize(
    bytes: &[u8],
    media_type: &str,
    max_bytes: u64,
) -> Option<(Vec<u8>, &'static str)> {
    if max_bytes == 0 || usize_to_u64(bytes.len()) <= max_bytes {
        return None;
    }
    if media_type == "image/gif" {
        warn!(
            size = bytes.len(),
            max = max_bytes,
            "GIF exceeds max_image_size but resizing is not supported; sending as-is"
        );
        return None;
    }
    let img = match image::load_from_memory(bytes) {
        Ok(img) => img,
        Err(e) => {
            warn!(error = %e, "Failed to decode image for resizing; sending original");
            return None;
        }
    };
    let (src_w, src_h) = (img.width(), img.height());
    if has_meaningful_alpha(&img) {
        resize_transparent(&img, src_w, src_h, usize_to_u64(bytes.len()), max_bytes)
    } else {
        let longest = src_w.max(src_h);
        if longest <= DIMENSION_FLOOR {
            resize_quality_only(&img, max_bytes).or_else(|| {
                resize_with_dims(&img, src_w, src_h, usize_to_u64(bytes.len()), max_bytes)
            })
        } else {
            resize_with_dims(&img, src_w, src_h, usize_to_u64(bytes.len()), max_bytes)
        }
    }
}

#[expect(
    clippy::float_arithmetic,
    reason = "image resizing estimates f64 scale factors from byte ratios for transparent PNGs"
)]
fn resize_transparent(
    img: &DynamicImage,
    src_w: u32,
    src_h: u32,
    src_bytes: u64,
    max_bytes: u64,
) -> Option<(Vec<u8>, &'static str)> {
    let scale = ((u64_to_f64(max_bytes) / u64_to_f64(src_bytes)).sqrt() * 0.85).min(1.0);
    let (new_w, new_h) = scaled_dims(src_w, src_h, scale);
    if let Some(buf) = fir_resize_and_encode_png(img, new_w, new_h) {
        if usize_to_u64(buf.len()) <= max_bytes {
            log_resize(
                src_w,
                src_h,
                new_w,
                new_h,
                src_bytes,
                usize_to_u64(buf.len()),
            );
            return Some((buf, "image/png"));
        }
        let correction = ((u64_to_f64(max_bytes) / usize_to_f64(buf.len())).sqrt() * 0.85).min(1.0);
        let (retry_w, retry_h) = scaled_dims(new_w, new_h, correction);
        if let Some(buf2) = fir_resize_and_encode_png(img, retry_w, retry_h) {
            if usize_to_u64(buf2.len()) > max_bytes {
                warn!(
                    size = buf2.len(),
                    max = max_bytes,
                    "Transparent image still exceeds limit after retry; sending best-effort result"
                );
            }
            log_resize(
                src_w,
                src_h,
                retry_w,
                retry_h,
                src_bytes,
                usize_to_u64(buf2.len()),
            );
            return Some((buf2, "image/png"));
        }
    }
    warn!("Failed to resize transparent image; sending original");
    None
}

fn resize_quality_only(img: &DynamicImage, max_bytes: u64) -> Option<(Vec<u8>, &'static str)> {
    for quality in [90_u8, 75] {
        if let Some(buf) = encode_jpeg_from_dynamic(img, img.width(), img.height(), quality) {
            if usize_to_u64(buf.len()) <= max_bytes {
                info!(
                    quality,
                    size = buf.len(),
                    "Reduced image quality without dimension change"
                );
                return Some((buf, "image/jpeg"));
            }
        }
    }
    None
}

#[expect(
    clippy::float_arithmetic,
    reason = "image resizing estimates f64 scale factors from byte and dimension ratios"
)]
fn resize_with_dims(
    img: &DynamicImage,
    src_w: u32,
    src_h: u32,
    src_bytes: u64,
    max_bytes: u64,
) -> Option<(Vec<u8>, &'static str)> {
    let format_factor = if u64_to_f64(src_bytes) / (f64::from(src_w) * f64::from(src_h)) > 3.0 {
        3.0
    } else {
        1.0
    };
    let raw_scale =
        ((u64_to_f64(max_bytes) * format_factor / u64_to_f64(src_bytes)).sqrt() * 0.85).min(1.0);
    let (mut new_w, mut new_h) = scaled_dims(src_w, src_h, raw_scale);
    if src_w.max(src_h) >= DIMENSION_FLOOR && new_w.max(new_h) < DIMENSION_FLOOR {
        let boost = f64::from(DIMENSION_FLOOR) / f64::from(new_w.max(new_h));
        new_w = f64_to_u32_saturating((f64::from(new_w) * boost).round());
        new_h = f64_to_u32_saturating((f64::from(new_h) * boost).round());
    }
    let quality: u8 = 90;
    if let Some(buf) = fir_resize_and_encode_jpeg(img, new_w, new_h, quality) {
        if usize_to_u64(buf.len()) <= max_bytes {
            log_resize(
                src_w,
                src_h,
                new_w,
                new_h,
                src_bytes,
                usize_to_u64(buf.len()),
            );
            return Some((buf, "image/jpeg"));
        }
        let correction = ((u64_to_f64(max_bytes) / usize_to_f64(buf.len())).sqrt() * 0.9).min(1.0);
        let (retry_w, retry_h) = scaled_dims(new_w, new_h, correction);
        let retry_q: u8 = 85;
        if let Some(buf2) = fir_resize_and_encode_jpeg(img, retry_w, retry_h, retry_q) {
            if usize_to_u64(buf2.len()) > max_bytes {
                warn!(
                    size = buf2.len(),
                    max = max_bytes,
                    "Image still exceeds limit after retry; sending best-effort result"
                );
            }
            log_resize(
                src_w,
                src_h,
                retry_w,
                retry_h,
                src_bytes,
                usize_to_u64(buf2.len()),
            );
            return Some((buf2, "image/jpeg"));
        }
    }
    warn!("Failed to resize image after retry; sending original");
    None
}

#[expect(
    clippy::float_arithmetic,
    reason = "image resizing applies a computed f64 scale factor to integer dimensions"
)]
fn scaled_dims(w: u32, h: u32, scale: f64) -> (u32, u32) {
    (
        f64_to_u32_saturating((f64::from(w) * scale).round().max(1.0)),
        f64_to_u32_saturating((f64::from(h) * scale).round().max(1.0)),
    )
}

fn fir_resize_and_encode_jpeg(
    img: &DynamicImage,
    dst_w: u32,
    dst_h: u32,
    quality: u8,
) -> Option<Vec<u8>> {
    let rgb = DynamicImage::ImageRgb8(img.to_rgb8());
    let pixel_type = fir::IntoImageView::pixel_type(&rgb)?;
    let mut dst = fir::images::Image::new(dst_w, dst_h, pixel_type);
    let mut resizer = fir::Resizer::new();
    if let Err(e) = resizer.resize(&rgb, &mut dst, None) {
        warn!(error = %e, "fast_image_resize failed");
        return None;
    }
    let mut buf = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut buf, quality);
    if let Err(e) = encoder.write_image(dst.buffer(), dst_w, dst_h, ExtendedColorType::Rgb8) {
        warn!(error = %e, "JPEG encode failed");
        return None;
    }
    Some(buf)
}

fn fir_resize_and_encode_png(img: &DynamicImage, dst_w: u32, dst_h: u32) -> Option<Vec<u8>> {
    let rgba = DynamicImage::ImageRgba8(img.to_rgba8());
    let pixel_type = fir::IntoImageView::pixel_type(&rgba)?;
    let mut dst = fir::images::Image::new(dst_w, dst_h, pixel_type);
    let mut resizer = fir::Resizer::new();
    if let Err(e) = resizer.resize(&rgba, &mut dst, None) {
        warn!(error = %e, "fast_image_resize failed");
        return None;
    }
    let mut buf = Vec::new();
    let encoder =
        PngEncoder::new_with_quality(&mut buf, CompressionType::Best, PngFilterType::Adaptive);
    if let Err(e) = encoder.write_image(dst.buffer(), dst_w, dst_h, ExtendedColorType::Rgba8) {
        warn!(error = %e, "PNG encode failed");
        return None;
    }
    Some(buf)
}

fn encode_jpeg_from_dynamic(img: &DynamicImage, w: u32, h: u32, quality: u8) -> Option<Vec<u8>> {
    let rgb = img.to_rgb8();
    let mut buf = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut buf, quality);
    if let Err(e) = encoder.write_image(rgb.as_raw(), w, h, ExtendedColorType::Rgb8) {
        warn!(error = %e, "JPEG encode failed in quality-only path");
        return None;
    }
    Some(buf)
}

fn log_resize(src_w: u32, src_h: u32, dst_w: u32, dst_h: u32, src_bytes: u64, dst_bytes: u64) {
    info!(
        original_size = src_bytes,
        resized_size = dst_bytes,
        original_dims = format!("{src_w}x{src_h}"),
        resized_dims = format!("{dst_w}x{dst_h}"),
        "Resized image for LLM upload"
    );
}

/// Compute a cache key from image path, modification time, and byte limit.
fn compute_cache_key(path: &str, mtime: std::time::SystemTime, max_bytes: u64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    let nanos = mtime
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    hasher.update(nanos.to_le_bytes());
    hasher.update(max_bytes.to_le_bytes());
    format!("{:x}", hasher.finalize())
}

/// Look up a cached resize result on disk. Returns `(bytes, media_type)` on hit.
fn read_cache(cache_dir: &Path, key: &str) -> Option<(Vec<u8>, &'static str)> {
    let jpg_path = cache_dir.join(format!("{key}.jpg"));
    if let Ok(bytes) = std::fs::read(&jpg_path) {
        return Some((bytes, "image/jpeg"));
    }
    let png_path = cache_dir.join(format!("{key}.png"));
    if let Ok(bytes) = std::fs::read(&png_path) {
        return Some((bytes, "image/png"));
    }
    None
}

/// Write a resize result to the cache directory.
fn write_cache(cache_dir: &Path, key: &str, bytes: &[u8], media_type: &str) {
    if let Err(e) = std::fs::create_dir_all(cache_dir) {
        warn!(error = %e, "Failed to create resize cache directory");
        return;
    }
    let ext = if media_type == "image/png" {
        "png"
    } else {
        "jpg"
    };
    let path = cache_dir.join(format!("{key}.{ext}"));
    if let Err(e) = std::fs::write(&path, bytes) {
        warn!(error = %e, "Failed to write to resize cache");
    }
}

/// Resize an image with caching. Checks the disk cache first; on miss,
/// runs `smart_resize` and writes the result to cache.
pub(super) fn cached_resize(
    path: &str,
    bytes: &[u8],
    media_type: &str,
    max_bytes: u64,
    cache_dir: &Path,
) -> Option<(Vec<u8>, &'static str)> {
    if max_bytes == 0 || usize_to_u64(bytes.len()) <= max_bytes {
        return None;
    }

    let mtime = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH);
    let key = compute_cache_key(path, mtime, max_bytes);

    let resized_dir = cache_dir.join("resized");
    if let Some(cached) = read_cache(&resized_dir, &key) {
        info!(path, "Using cached resized image");
        return Some(cached);
    }

    let (resized_bytes, result_media_type) = smart_resize(bytes, media_type, max_bytes)?;
    write_cache(&resized_dir, &key, &resized_bytes, result_media_type);
    Some((resized_bytes, result_media_type))
}

/// Pre-warm the resize cache for all images in the prompt messages.
///
/// Runs resize operations on tokio's blocking thread pool so the async
/// event loop is not stalled. Multiple images are processed concurrently.
pub(crate) async fn warm_image_cache(
    messages: &[crate::engine::prompt::PromptMessage],
    max_bytes: u64,
    cache_dir_ref: &Path,
) {
    use futures::future::join_all;

    if max_bytes == 0 {
        return;
    }

    let mut work: Vec<(String, String)> = Vec::new();
    for msg in messages {
        for img in &msg.images {
            if let Some(mt) = super::images::media_type_for_path(&img.path) {
                if let Ok(meta) = std::fs::metadata(&img.path) {
                    if meta.len() > max_bytes {
                        work.push((img.path.clone(), mt.to_owned()));
                    }
                }
            }
        }
    }

    if work.is_empty() {
        return;
    }

    let cache_dir = cache_dir_ref.to_path_buf();
    let futures: Vec<_> = work
        .into_iter()
        .map(|(path, media_type)| {
            let task_dir = cache_dir.clone();
            tokio::task::spawn_blocking(move || {
                if let Ok(bytes) = std::fs::read(&path) {
                    let _ignored = cached_resize(&path, &bytes, &media_type, max_bytes, &task_dir);
                }
            })
        })
        .collect();

    for result in join_all(futures).await {
        if let Err(e) = result {
            warn!(error = %e, "Image cache warm-up task failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_opaque_rgba(w: u32, h: u32) -> Vec<u8> {
        let mut img = image::RgbaImage::new(w, h);
        for p in img.pixels_mut() {
            *p = image::Rgba([128, 64, 200, 255]);
        }
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        DynamicImage::ImageRgba8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        buf
    }

    fn make_transparent_rgba(w: u32, h: u32) -> Vec<u8> {
        let mut img = image::RgbaImage::new(w, h);
        for (i, p) in img.pixels_mut().enumerate() {
            let alpha = if i % 4 == 0 { 0 } else { 255 };
            *p = image::Rgba([128, 64, 200, alpha]);
        }
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        DynamicImage::ImageRgba8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        buf
    }

    fn fill_noise(pixels: &mut [u8], seed: u64) {
        let mut state = seed;
        for byte in pixels.iter_mut() {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            *byte = u8::try_from((state >> 33) & 0xff).unwrap_or(0);
        }
    }

    fn rgb_len(w: u32, h: u32) -> usize {
        usize::try_from(w.saturating_mul(h).saturating_mul(3)).unwrap_or(usize::MAX)
    }

    fn rgba_len(w: u32, h: u32) -> usize {
        usize::try_from(w.saturating_mul(h).saturating_mul(4)).unwrap_or(usize::MAX)
    }

    fn make_noisy_jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut pixels = vec![0_u8; rgb_len(w, h)];
        fill_noise(&mut pixels, 0xdead_beef_cafe_babe);
        let img = image::RgbImage::from_raw(w, h, pixels).unwrap();
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Jpeg)
            .unwrap();
        buf
    }

    fn make_noisy_png_rgb(w: u32, h: u32) -> Vec<u8> {
        let mut pixels = vec![0_u8; rgb_len(w, h)];
        fill_noise(&mut pixels, 0xcafe_f00d_1234_5678);
        let img = image::RgbImage::from_raw(w, h, pixels).unwrap();
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        DynamicImage::ImageRgb8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        buf
    }

    fn make_noisy_transparent_png(w: u32, h: u32) -> Vec<u8> {
        let mut pixels = vec![0_u8; rgba_len(w, h)];
        fill_noise(&mut pixels, 0xbabe_cafe_dead_f00d);
        for chunk in pixels.chunks_mut(4) {
            if chunk[0] < 64 {
                chunk[3] = 0;
            }
        }
        let img = image::RgbaImage::from_raw(w, h, pixels).unwrap();
        let mut buf = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut buf);
        DynamicImage::ImageRgba8(img)
            .write_to(&mut cursor, image::ImageFormat::Png)
            .unwrap();
        buf
    }

    #[test]
    fn alpha_detection_opaque_rgba() {
        let png = make_opaque_rgba(100, 100);
        let img = image::load_from_memory(&png).unwrap();
        assert!(!has_meaningful_alpha(&img));
    }

    #[test]
    fn alpha_detection_transparent_rgba() {
        let png = make_transparent_rgba(100, 100);
        let img = image::load_from_memory(&png).unwrap();
        assert!(has_meaningful_alpha(&img));
    }

    #[test]
    fn alpha_detection_rgb_image() {
        let jpeg = make_noisy_jpeg(100, 100);
        let img = image::load_from_memory(&jpeg).unwrap();
        assert!(!has_meaningful_alpha(&img));
    }

    #[test]
    fn smart_resize_returns_none_under_limit() {
        let jpeg = make_noisy_jpeg(100, 100);
        assert!(smart_resize(&jpeg, "image/jpeg", 10_000_000).is_none());
    }

    #[test]
    fn smart_resize_returns_none_when_disabled() {
        let jpeg = make_noisy_jpeg(100, 100);
        assert!(smart_resize(&jpeg, "image/jpeg", 0).is_none());
    }

    #[test]
    fn smart_resize_passes_through_gif() {
        let fake_gif = vec![0_u8; 1_000_000];
        assert!(smart_resize(&fake_gif, "image/gif", 100).is_none());
    }

    #[test]
    fn smart_resize_opaque_png_becomes_jpeg() {
        let png = make_noisy_png_rgb(2000, 2000);
        let max = usize_to_u64(png.len()) / 4;
        let result = smart_resize(&png, "image/png", max);
        assert!(result.is_some(), "Should resize oversized opaque PNG");
        let (resized, media_type) = result.unwrap();
        assert_eq!(media_type, "image/jpeg");
        assert!(
            usize_to_u64(resized.len()) <= max,
            "Resized ({}) should be under limit ({})",
            resized.len(),
            max
        );
        assert_eq!(&resized[..2], &[0xFF, 0xD8]);
    }

    #[test]
    fn smart_resize_transparent_png_stays_png() {
        let png = make_noisy_transparent_png(2000, 2000);
        let max = usize_to_u64(png.len()) / 2;
        let result = smart_resize(&png, "image/png", max);
        assert!(result.is_some(), "Should resize oversized transparent PNG");
        let (resized, media_type) = result.unwrap();
        assert_eq!(media_type, "image/png");
        assert!(
            usize_to_u64(resized.len()) <= max,
            "Resized ({}) should be under limit ({})",
            resized.len(),
            max
        );
        assert_eq!(&resized[..4], &[0x89, 0x50, 0x4E, 0x47]);
    }

    #[test]
    fn smart_resize_small_image_quality_only() {
        let jpeg = make_noisy_jpeg(1000, 1000);
        let max = usize_to_u64(jpeg.len()) / 2;
        let result = smart_resize(&jpeg, "image/jpeg", max);
        assert!(result.is_some());
        let (resized, media_type) = result.unwrap();
        assert_eq!(media_type, "image/jpeg");
        assert!(usize_to_u64(resized.len()) <= max);
    }

    #[test]
    fn smart_resize_large_image_under_limit() {
        let jpeg = make_noisy_jpeg(4000, 3000);
        assert!(jpeg.len() > 2_000_000, "Test image should exceed 2MB");
        let result = smart_resize(&jpeg, "image/jpeg", 2_000_000);
        assert!(result.is_some());
        let (resized, _) = result.unwrap();
        assert!(
            resized.len() <= 2_000_000,
            "Resized ({}) should be under 2MB",
            resized.len()
        );
    }

    #[test]
    fn smart_resize_respects_dimension_floor() {
        let jpeg = make_noisy_jpeg(4000, 3000);
        let max = usize_to_u64(jpeg.len()) / 3;
        let result = smart_resize(&jpeg, "image/jpeg", max);
        assert!(result.is_some());
        let (resized, _) = result.unwrap();
        let decoded = image::load_from_memory(&resized).unwrap();
        let longest = decoded.width().max(decoded.height());
        assert!(
            longest >= 1024,
            "Longest side ({longest}) should respect dimension floor"
        );
    }

    // ── cache tests ──────────────────────────────────────────────────

    #[test]
    fn cache_miss_resizes_and_writes() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cache_dir = tmp.path().to_path_buf();
        let img_dir = tmp.path().join("images");
        std::fs::create_dir_all(&img_dir).unwrap();

        let jpeg = make_noisy_jpeg(3000, 2000);
        let img_path = img_dir.join("photo.jpg");
        std::fs::write(&img_path, &jpeg).unwrap();
        assert!(jpeg.len() > 2_000_000);

        let result = cached_resize(
            img_path.to_str().unwrap(),
            &jpeg,
            "image/jpeg",
            2_000_000,
            &cache_dir,
        );
        assert!(result.is_some());
        let (resized, _) = result.unwrap();
        assert!(resized.len() <= 2_000_000);

        // Cache file should now exist
        let resized_dir = cache_dir.join("resized");
        assert!(resized_dir.exists());
        let entries: Vec<_> = std::fs::read_dir(&resized_dir).unwrap().collect();
        assert_eq!(entries.len(), 1, "Should have exactly one cached file");
    }

    #[test]
    fn cache_hit_skips_resize() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cache_dir = tmp.path().to_path_buf();
        let img_dir = tmp.path().join("images");
        std::fs::create_dir_all(&img_dir).unwrap();

        let jpeg = make_noisy_jpeg(3000, 2000);
        let img_path = img_dir.join("photo.jpg");
        std::fs::write(&img_path, &jpeg).unwrap();

        // First call: cache miss
        let r1 = cached_resize(
            img_path.to_str().unwrap(),
            &jpeg,
            "image/jpeg",
            2_000_000,
            &cache_dir,
        );
        assert!(r1.is_some());

        // Second call: should hit cache and return same bytes
        let r2 = cached_resize(
            img_path.to_str().unwrap(),
            &jpeg,
            "image/jpeg",
            2_000_000,
            &cache_dir,
        );
        assert!(r2.is_some());
        let (bytes1, mt1) = r1.unwrap();
        let (bytes2, mt2) = r2.unwrap();
        assert_eq!(mt1, mt2);
        assert_eq!(bytes1.len(), bytes2.len());
    }

    #[test]
    fn cache_invalidates_on_config_change() {
        let tmp = tempfile::TempDir::new().unwrap();
        let cache_dir = tmp.path().to_path_buf();
        let img_dir = tmp.path().join("images");
        std::fs::create_dir_all(&img_dir).unwrap();

        let jpeg = make_noisy_jpeg(3000, 2000);
        let img_path = img_dir.join("photo.jpg");
        std::fs::write(&img_path, &jpeg).unwrap();

        // Resize with 2MB limit
        let r1 = cached_resize(
            img_path.to_str().unwrap(),
            &jpeg,
            "image/jpeg",
            2_000_000,
            &cache_dir,
        );
        assert!(r1.is_some());

        // Same image, different limit — should NOT use the old cached version
        let r2 = cached_resize(
            img_path.to_str().unwrap(),
            &jpeg,
            "image/jpeg",
            1_000_000,
            &cache_dir,
        );
        assert!(r2.is_some());

        // Cache dir should have 2 files (different keys)
        let resized_dir = cache_dir.join("resized");
        let entries: Vec<_> = std::fs::read_dir(&resized_dir).unwrap().collect();
        assert_eq!(
            entries.len(),
            2,
            "Different limits should produce separate cache entries"
        );
    }
}
