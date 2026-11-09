use std::collections::HashMap;
use std::io::Write;

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};
use shore_common::protocol::types::{ContentBlock, ImageRef, ImageSource, ToolResultContent};

pub(crate) fn tool_result_parts(
    content: &ToolResultContent,
    tool_name: &str,
) -> (String, Vec<ImageRef>) {
    use sha2::{Digest as _, Sha256};

    let ToolResultContent::Blocks(blocks) = content else {
        return (content.display_text(), Vec::new());
    };
    let mut text_blocks = Vec::new();
    let mut images = Vec::new();
    for block in blocks {
        if let ContentBlock::Image {
            source: ImageSource::Base64 { data, .. },
        } = block
        {
            images.push(ImageRef {
                path: format!(
                    "tool-image:{}",
                    base64_encode(Sha256::digest(data.as_bytes()).as_slice())
                ),
                caption: Some(format!("{tool_name} image")),
                data: Some(data.clone()),
                ..ImageRef::default()
            });
        } else {
            text_blocks.push(block.clone());
        }
    }
    (
        ToolResultContent::Blocks(text_blocks).display_text(),
        images,
    )
}

pub(crate) use shore_common::image_protocol::ImageProtocol;
pub(crate) use shore_common::image_protocol::detect_protocol as detect_protocol_from_env;
pub(crate) use shore_common::image_protocol::detect_protocol_probe;

pub(crate) type KittyImageId = u32;

pub(crate) struct TransmittedImage {
    pub id: KittyImageId,
    pub cols: u16,
    pub rows: u16,
    pub pw: u32,
    pub ph: u32,
}

pub(crate) struct ImageCache {
    next_id: u32,
    cache: HashMap<String, TransmittedImage>,
    protocol: Option<ImageProtocol>,
    cell_width: u16,
    cell_height: u16,
}

fn open_tty_write() -> Option<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/tty")
        .ok()
}

#[cfg(unix)]
fn query_cell_size() -> Option<(u16, u16)> {
    cell_size_of(&std::fs::File::open("/dev/tty").ok()?)
}

#[cfg(unix)]
#[expect(
    unsafe_code,
    reason = "TIOCGWINSZ is the only way to read cell pixel size; no safe std wrapper"
)]
fn cell_size_of(tty: &impl std::os::unix::io::AsRawFd) -> Option<(u16, u16)> {
    let fd = tty.as_raw_fd();

    // SAFETY: `winsize` is four `u16`s with no padding and no invalid bit
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    // SAFETY: `fd` comes from the `tty` file, which outlives this call, and
    let ret = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) };
    if ret != 0 || ws.ws_xpixel == 0 || ws.ws_ypixel == 0 || ws.ws_col == 0 || ws.ws_row == 0 {
        return None;
    }
    let cw = ws.ws_xpixel.checked_div(ws.ws_col)?;
    let ch = ws.ws_ypixel.checked_div(ws.ws_row)?;
    if cw == 0 || ch == 0 {
        return None;
    }
    Some((cw, ch))
}

#[cfg(not(unix))]
fn query_cell_size() -> Option<(u16, u16)> {
    None
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn ensure_png(data: &[u8]) -> Option<Vec<u8>> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(data.to_vec());
    }
    let img = image::load_from_memory(data).ok()?;
    let mut png_buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png_buf, image::ImageFormat::Png).ok()?;
    Some(png_buf.into_inner())
}

#[rustfmt::skip]
const DIACRITICS: [u32; 256] = [
    0x0305, 0x030D, 0x030E, 0x0310, 0x0312, 0x033D, 0x033E, 0x033F,
    0x0346, 0x034A, 0x034B, 0x034C, 0x0350, 0x0351, 0x0352, 0x0357,
    0x035B, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
    0x036A, 0x036B, 0x036C, 0x036D, 0x036E, 0x036F, 0x0483, 0x0484,
    0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
    0x0598, 0x0599, 0x059C, 0x059D, 0x059E, 0x059F, 0x05A0, 0x05A1,
    0x05A8, 0x05A9, 0x05AB, 0x05AC, 0x05AF, 0x05C4, 0x0610, 0x0611,
    0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658,
    0x0659, 0x065A, 0x065B, 0x065D, 0x065E, 0x06D6, 0x06D7, 0x06D8,
    0x06D9, 0x06DA, 0x06DB, 0x06DC, 0x06DF, 0x06E0, 0x06E1, 0x06E2,
    0x06E4, 0x06E7, 0x06E8, 0x06EB, 0x06EC, 0x0730, 0x0732, 0x0733,
    0x0735, 0x0736, 0x073A, 0x073D, 0x073F, 0x0740, 0x0741, 0x0743,
    0x0745, 0x0747, 0x0749, 0x074A, 0x07EB, 0x07EC, 0x07ED, 0x07EE,
    0x07EF, 0x07F0, 0x07F1, 0x07F3, 0x0816, 0x0817, 0x0818, 0x0819,
    0x081B, 0x081C, 0x081D, 0x081E, 0x081F, 0x0820, 0x0821, 0x0822,
    0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082A, 0x082B, 0x082C,
    0x082D, 0x0951, 0x0953, 0x0954, 0x0F82, 0x0F83, 0x0F86, 0x0F87,
    0x135D, 0x135E, 0x135F, 0x17DD, 0x193A, 0x1A17, 0x1A75, 0x1A76,
    0x1A77, 0x1A78, 0x1A79, 0x1A7A, 0x1A7B, 0x1A7C, 0x1B6B, 0x1B6D,
    0x1B6E, 0x1B6F, 0x1B70, 0x1B71, 0x1B72, 0x1B73, 0x1CD0, 0x1CD1,
    0x1CD2, 0x1CDA, 0x1CDB, 0x1CE0, 0x1DC0, 0x1DC1, 0x1DC3, 0x1DC4,
    0x1DC5, 0x1DC6, 0x1DC7, 0x1DC8, 0x1DC9, 0x1DCB, 0x1DCC, 0x1DD1,
    0x1DD2, 0x1DD3, 0x1DD4, 0x1DD5, 0x1DD6, 0x1DD7, 0x1DD8, 0x1DD9,
    0x1DDA, 0x1DDB, 0x1DDC, 0x1DDD, 0x1DDE, 0x1DDF, 0x1DE0, 0x1DE1,
    0x1DE2, 0x1DE3, 0x1DE4, 0x1DE5, 0x1DE6, 0x1DFE, 0x20D0, 0x20D1,
    0x20D4, 0x20D5, 0x20D6, 0x20D7, 0x20DB, 0x20DC, 0x20E1, 0x20E7,
    0x20E9, 0x20F0, 0x2CEF, 0x2CF0, 0x2CF1, 0x2DE0, 0x2DE1, 0x2DE2,
    0x2DE3, 0x2DE4, 0x2DE5, 0x2DE6, 0x2DE7, 0x2DE8, 0x2DE9, 0x2DEA,
    0x2DEB, 0x2DEC, 0x2DED, 0x2DEE, 0x2DEF, 0x2DF0, 0x2DF1, 0x2DF2,
    0x2DF3, 0x2DF4, 0x2DF5, 0x2DF6, 0x2DF7, 0x2DF8, 0x2DF9, 0x2DFA,
    0x2DFB, 0x2DFC, 0x2DFD, 0x2DFE, 0x2DFF, 0xA66F, 0xA67C, 0xA67D,
    0xA6F0, 0xA6F1, 0xA8E0, 0xA8E1, 0xA8E2, 0xA8E3, 0xA8E4, 0xA8E5,
];

impl ImageCache {
    pub(crate) fn new() -> Self {
        let (cw, ch) = query_cell_size().unwrap_or((8, 16));
        Self {
            next_id: 1,
            cache: HashMap::new(),
            protocol: detect_protocol_from_env(),
            cell_width: cw,
            cell_height: ch,
        }
    }

    pub(crate) fn probe_protocol(&mut self) {
        self.probe_with(detect_protocol_probe, query_cell_size);
    }

    fn probe_with(
        &mut self,
        detect: impl FnOnce() -> Option<ImageProtocol>,
        cell_size: impl FnOnce() -> Option<(u16, u16)>,
    ) {
        if self.protocol.is_none() {
            self.protocol = detect();
        }
        if let Some((cw, ch)) = cell_size() {
            self.cell_width = cw;
            self.cell_height = ch;
        }
    }

    pub(crate) fn ensure_transmitted(
        &mut self,
        path: &str,
        max_cols: u16,
        max_rows: u16,
    ) -> Option<&TransmittedImage> {
        self.transmit_once(
            path,
            max_cols,
            max_rows,
            || std::fs::read(path).ok(),
            open_tty_write,
        )
    }

    pub(crate) fn ensure_transmitted_from_b64(
        &mut self,
        key: &str,
        b64_data: &str,
        max_cols: u16,
        max_rows: u16,
    ) -> Option<&TransmittedImage> {
        use base64::Engine as _;

        self.transmit_once(
            key,
            max_cols,
            max_rows,
            || {
                base64::engine::general_purpose::STANDARD
                    .decode(b64_data)
                    .ok()
            },
            open_tty_write,
        )
    }

    fn transmit_once<W: Write>(
        &mut self,
        key: &str,
        max_cols: u16,
        max_rows: u16,
        read: impl FnOnce() -> Option<Vec<u8>>,
        open_tty: impl FnOnce() -> Option<W>,
    ) -> Option<&TransmittedImage> {
        if self.protocol != Some(ImageProtocol::Kitty) {
            return None;
        }
        if self.cache.contains_key(key) {
            return self.cache.get(key);
        }

        let data = read()?;
        let (pw, ph) = image_dimensions(&data)?;
        let (cols, rows) = self.calculate_cells(pw, ph, max_cols, max_rows);

        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);

        let png_data = ensure_png(&data)?;
        let encoded = base64_encode(&png_data);
        let mut tty = open_tty()?;
        transmit_kitty_data(&mut tty, id, &encoded);
        place_kitty(&mut tty, id, cols, rows);
        drop(tty.flush());

        let _previous = self.cache.insert(
            key.to_owned(),
            TransmittedImage {
                id,
                cols,
                rows,
                pw,
                ph,
            },
        );
        self.cache.get(key)
    }

    pub(crate) fn get(&self, path: &str) -> Option<&TransmittedImage> {
        self.cache.get(path)
    }

    pub(crate) fn version(&self) -> (u32, usize) {
        (self.next_id, self.cache.len())
    }

    pub(crate) fn clear(&mut self) {
        self.clear_on(open_tty_write);
    }

    fn clear_on<W: Write>(&mut self, open_tty: impl FnOnce() -> Option<W>) {
        if self.protocol == Some(ImageProtocol::Kitty)
            && !self.cache.is_empty()
            && let Some(mut tty) = open_tty()
        {
            drop(write!(tty, "\x1b_Ga=d,q=2\x1b\\"));
            drop(tty.flush());
        }
        self.cache.clear();
    }

    #[expect(
        clippy::as_conversions,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::float_arithmetic,
        reason = "terminal pixel-to-cell scaling is bounded to positive u16 dimensions immediately after calculation"
    )]
    pub(crate) fn calculate_cells(
        &self,
        pw: u32,
        ph: u32,
        max_cols: u16,
        max_rows: u16,
    ) -> (u16, u16) {
        let cw = f64::from(self.cell_width);
        let ch = f64::from(self.cell_height);

        let natural_cols = f64::from(pw) / cw;
        let cols_f = natural_cols.min(f64::from(max_cols)).max(1.0);
        let scale_w = (cols_f * cw) / f64::from(pw);
        let rows_from_w = (f64::from(ph) * scale_w / ch).ceil();

        let (cols, rows) = if rows_from_w > f64::from(max_rows) {
            let scale_h = (f64::from(max_rows) * ch) / f64::from(ph);
            let cols_from_h = (f64::from(pw) * scale_h / cw).floor().max(1.0);
            (cols_from_h as u16, max_rows)
        } else {
            (cols_f as u16, rows_from_w as u16)
        };

        (cols.max(1), rows.clamp(1, 255))
    }
}

pub(crate) fn placeholder_lines(img: &TransmittedImage) -> Vec<Line<'static>> {
    let style = id_to_style(img.id);
    let mut lines = Vec::with_capacity(usize::from(img.rows));
    for row in 0..img.rows {
        let mut text = String::with_capacity(usize::from(img.cols).saturating_mul(12));
        for col in 0..img.cols {
            text.push('\u{2800}');
            text.push(diacritic(u8::try_from(row).unwrap_or(u8::MAX)));
            text.push(diacritic(u8::try_from(col).unwrap_or(u8::MAX)));
        }
        lines.push(Line::from(Span::styled(text, style)));
    }
    lines
}

pub(crate) fn placeholder_lines_at(id: KittyImageId, cols: u16, rows: u16) -> Vec<Line<'static>> {
    let style = id_to_style(id);
    let mut lines = Vec::with_capacity(usize::from(rows));
    for row in 0..rows {
        let mut text = String::with_capacity(usize::from(cols).saturating_mul(12));
        for col in 0..cols {
            text.push('\u{2800}');
            text.push(diacritic(u8::try_from(row).unwrap_or(u8::MAX)));
            text.push(diacritic(u8::try_from(col).unwrap_or(u8::MAX)));
        }
        lines.push(Line::from(Span::styled(text, style)));
    }
    lines
}

pub(crate) fn fixup_placeholder_cells(
    buf: &mut ratatui::buffer::Buffer,
    area: ratatui::layout::Rect,
) {
    for y in area.y..area.y.saturating_add(area.height) {
        for x in area.x..area.x.saturating_add(area.width) {
            let Some(cell) = buf.cell((x, y)) else {
                continue;
            };
            let sym = cell.symbol();
            if let Some(rest) = sym.strip_prefix('\u{2800}')
                && !rest.is_empty()
            {
                let mut new_sym = String::with_capacity(4_usize.saturating_add(rest.len()));
                new_sym.push('\u{10EEEE}');
                new_sym.push_str(rest);
                if let Some(target_cell) = buf.cell_mut((x, y)) {
                    let _cell = target_cell.set_symbol(&new_sym);
                }
            }
        }
    }
}

fn diacritic(value: u8) -> char {
    DIACRITICS
        .get(usize::from(value))
        .copied()
        .and_then(char::from_u32)
        .unwrap_or('\u{FFFD}')
}

fn id_to_style(id: u32) -> Style {
    if id < 256 {
        Style::default().fg(Color::Indexed(u8::try_from(id).unwrap_or(u8::MAX)))
    } else {
        let r = u8::try_from(id & 0xFF).unwrap_or_default();
        let g = u8::try_from((id >> 8) & 0xFF).unwrap_or_default();
        let b = u8::try_from((id >> 16) & 0xFF).unwrap_or_default();
        Style::default().fg(Color::Rgb(r, g, b))
    }
}

fn transmit_kitty_data<W: Write>(w: &mut W, id: u32, encoded: &str) {
    const CHUNK_SIZE: usize = 4096;
    let chunks: Vec<&str> = encoded
        .as_bytes()
        .chunks(CHUNK_SIZE)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect();

    for (i, chunk) in chunks.iter().enumerate() {
        let more = i32::from(i.saturating_add(1) < chunks.len());
        if i == 0 {
            drop(write!(
                w,
                "\x1b_Ga=t,f=100,q=2,i={id},m={more};{chunk}\x1b\\"
            ));
        } else {
            drop(write!(w, "\x1b_Gq=2,m={more};{chunk}\x1b\\"));
        }
    }
}

fn place_kitty<W: Write>(w: &mut W, id: u32, cols: u16, rows: u16) {
    drop(write!(
        w,
        "\x1b_Ga=p,U=1,q=2,i={id},c={cols},r={rows}\x1b\\"
    ));
}

fn read_u16_be(data: &[u8], offset: usize) -> Option<u16> {
    let bytes: [u8; 2] = data
        .get(offset..offset.saturating_add(2))?
        .try_into()
        .ok()?;
    Some(u16::from_be_bytes(bytes))
}

fn read_u16_le(data: &[u8], offset: usize) -> Option<u16> {
    let bytes: [u8; 2] = data
        .get(offset..offset.saturating_add(2))?
        .try_into()
        .ok()?;
    Some(u16::from_le_bytes(bytes))
}

fn read_u32_be(data: &[u8], offset: usize) -> Option<u32> {
    let bytes: [u8; 4] = data
        .get(offset..offset.saturating_add(4))?
        .try_into()
        .ok()?;
    Some(u32::from_be_bytes(bytes))
}

fn read_u32_le(data: &[u8], offset: usize) -> Option<u32> {
    let bytes: [u8; 4] = data
        .get(offset..offset.saturating_add(4))?
        .try_into()
        .ok()?;
    Some(u32::from_le_bytes(bytes))
}

fn image_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    if data.len() >= 24 && data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some((read_u32_be(data, 16)?, read_u32_be(data, 20)?));
    }
    if data.starts_with(&[0xFF, 0xD8]) {
        let mut i: usize = 2;
        while i.saturating_add(9) < data.len() {
            if data.get(i).copied()? != 0xFF {
                i = i.saturating_add(1);
                continue;
            }
            let marker = data.get(i.saturating_add(1)).copied()?;
            if marker == 0xC0 || marker == 0xC2 {
                let h = u32::from(read_u16_be(data, i.saturating_add(5))?);
                let w = u32::from(read_u16_be(data, i.saturating_add(7))?);
                return Some((w, h));
            }
            if i.saturating_add(3) < data.len() {
                let len = usize::from(read_u16_be(data, i.saturating_add(2))?);
                i = i.saturating_add(2).saturating_add(len);
            } else {
                break;
            }
        }
    }
    if data.len() >= 30 && data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP".as_slice())
    {
        if data.get(12..16) == Some(b"VP8 ".as_slice()) {
            let w = u32::from(read_u16_le(data, 26)? & 0x3FFF);
            let h = u32::from(read_u16_le(data, 28)? & 0x3FFF);
            return Some((w, h));
        }
        if data.get(12..16) == Some(b"VP8L".as_slice()) && data.len() >= 25 {
            let b = read_u32_le(data, 21)?;
            let w = (b & 0x3FFF).saturating_add(1);
            let h = ((b >> 14) & 0x3FFF).saturating_add(1);
            return Some((w, h));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(width: u32, height: u32, format: image::ImageFormat) -> Vec<u8> {
        let picture = image::RgbImage::from_pixel(width, height, image::Rgb([200, 40, 40]));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(picture)
            .write_to(&mut bytes, format)
            .unwrap();
        bytes.into_inner()
    }

    fn cache(cell_width: u16, cell_height: u16) -> ImageCache {
        ImageCache {
            next_id: 1,
            cache: HashMap::new(),
            protocol: None,
            cell_width,
            cell_height,
        }
    }

    fn webp(kind: &[u8; 4], tail: &[u8]) -> Vec<u8> {
        let mut bytes = b"RIFF\x00\x00\x00\x00WEBP".to_vec();
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(tail);
        bytes
    }

    #[test]
    fn png_and_jpeg_sizes_are_read_from_their_headers() {
        assert_eq!(
            image_dimensions(&encoded(3, 2, image::ImageFormat::Png)),
            Some((3, 2))
        );
        assert_eq!(
            image_dimensions(&encoded(5, 4, image::ImageFormat::Jpeg)),
            Some((5, 4))
        );
        let png = encoded(300, 2, image::ImageFormat::Png);
        assert_eq!(image_dimensions(&png), Some((300, 2)));
        assert_eq!(
            image_dimensions(png.get(..23).unwrap_or_default()),
            None,
            "a PNG cut before its size"
        );
        assert_eq!(
            image_dimensions(b"GIF89a\x03\x00\x02\x00"),
            None,
            "only what the terminal draws"
        );
        assert_eq!(image_dimensions(b"plain text, not a picture"), None);
    }

    #[test]
    fn a_jpeg_size_is_found_past_other_segments_padding_and_in_progressive_files() {
        let mut progressive = vec![0xFF, 0xD8, 0x00, 0x00];
        progressive.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x04, 0xAA, 0xBB]);
        progressive
            .extend_from_slice(&[0xFF, 0xC2, 0x00, 0x11, 0x08, 0x01, 0x2C, 0x02, 0x58, 0x03]);
        progressive.extend_from_slice(&[0x00; 8]);
        assert_eq!(image_dimensions(&progressive), Some((600, 300)));

        let mut baseline = vec![0xFF, 0xD8];
        baseline.extend_from_slice(&[0xFF, 0xDB, 0x00, 0x03, 0x01]);
        baseline.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03]);
        assert_eq!(image_dimensions(&baseline), Some((32, 16)));

        let cut = baseline
            .get(..baseline.len().saturating_sub(1))
            .unwrap_or_default()
            .to_vec();
        assert_eq!(
            image_dimensions(&cut),
            None,
            "a frame header cut short is no size"
        );
        assert_eq!(
            image_dimensions(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x02]),
            None
        );
    }

    #[test]
    fn webp_sizes_are_read_for_lossy_and_lossless_files() {
        let mut lossy_tail = vec![0_u8; 10];
        lossy_tail.extend_from_slice(&[0x2C, 0xC1, 0x58, 0x02]);
        assert_eq!(
            image_dimensions(&webp(b"VP8 ", &lossy_tail)),
            Some((300, 600)),
            "the scale bits above the size are dropped"
        );
        let lossless_bits: u32 = (599 << 14) | 299;
        let mut lossless_tail = vec![0_u8; 5];
        lossless_tail.extend_from_slice(&lossless_bits.to_le_bytes());
        lossless_tail.extend_from_slice(&[0; 5]);
        assert_eq!(
            image_dimensions(&webp(b"VP8L", &lossless_tail)),
            Some((300, 600))
        );
        assert_eq!(
            image_dimensions(&webp(b"VP8X", &[0; 14])),
            None,
            "the extended form is not read"
        );
        let short = webp(b"VP8 ", &[0; 13]);
        assert_eq!(image_dimensions(&short), None, "too short for a size");
    }

    #[test]
    fn numbers_are_read_in_the_byte_order_asked_for_and_never_past_the_end() {
        let bytes = [0x01, 0x02, 0x03, 0x04, 0x05];
        assert_eq!(read_u16_be(&bytes, 1), Some(0x0203));
        assert_eq!(read_u16_le(&bytes, 1), Some(0x0302));
        assert_eq!(read_u32_be(&bytes, 1), Some(0x0203_0405));
        assert_eq!(read_u32_le(&bytes, 1), Some(0x0504_0302));
        assert_eq!(read_u16_be(&bytes, 4), None);
        assert_eq!(read_u16_le(&bytes, 4), None);
        assert_eq!(read_u32_be(&bytes, 2), None);
        assert_eq!(read_u32_le(&bytes, 2), None);
        assert_eq!(read_u32_le(&bytes, usize::MAX), None);
    }

    #[test]
    fn a_picture_takes_the_cells_its_pixels_need_within_the_space_it_is_given() {
        let cells = cache(8, 16);
        assert_eq!(
            cells.calculate_cells(80, 32, 100, 50),
            (10, 2),
            "its own size"
        );
        assert_eq!(
            cells.calculate_cells(80, 33, 100, 50),
            (10, 3),
            "a part row is a whole row"
        );
        assert_eq!(
            cells.calculate_cells(800, 160, 20, 50),
            (20, 2),
            "narrowed to the width given"
        );
        assert_eq!(
            cells.calculate_cells(80, 800, 100, 10),
            (2, 10),
            "shortened to the height given"
        );
        assert_eq!(
            cells.calculate_cells(2, 2, 100, 50),
            (1, 1),
            "never under one cell"
        );
        assert_eq!(cells.calculate_cells(1, 1000, 100, 50), (1, 50));
        assert_eq!(
            cells.calculate_cells(8, 100_000, 100, 1000),
            (1, 255),
            "at most 255 rows"
        );
        assert_eq!(
            cache(10, 20).calculate_cells(100, 40, 100, 50),
            (10, 2),
            "by the terminal's own cell size"
        );
    }

    #[test]
    fn an_image_id_is_drawn_as_its_placeholder_colour() {
        assert_eq!(id_to_style(1), Style::default().fg(Color::Indexed(1)));
        assert_eq!(id_to_style(255), Style::default().fg(Color::Indexed(255)));
        assert_eq!(id_to_style(256), Style::default().fg(Color::Rgb(0, 1, 0)));
        assert_eq!(
            id_to_style(0x0012_3456),
            Style::default().fg(Color::Rgb(0x56, 0x34, 0x12))
        );
    }

    #[test]
    fn placeholders_mark_each_cell_with_its_row_and_column() {
        let at = |index: u8| {
            DIACRITICS
                .get(usize::from(index))
                .copied()
                .and_then(char::from_u32)
                .unwrap_or('?')
        };
        let expected_row = |row: u8| -> String {
            [0_u8, 1_u8]
                .into_iter()
                .flat_map(|col| ['\u{2800}', at(row), at(col)])
                .collect()
        };
        let image = TransmittedImage {
            id: 300,
            cols: 2,
            rows: 3,
            pw: 0,
            ph: 0,
        };
        for lines in [placeholder_lines(&image), placeholder_lines_at(300, 2, 3)] {
            let texts: Vec<String> = lines.iter().map(ToString::to_string).collect();
            assert_eq!(texts, [expected_row(0), expected_row(1), expected_row(2)]);
            assert!(
                lines
                    .iter()
                    .flat_map(|line| line.spans.iter())
                    .all(|span| span.style == id_to_style(300))
            );
        }
        assert_eq!(diacritic(255), '\u{A8E5}');
    }

    #[test]
    fn placeholder_cells_are_rewritten_for_the_terminal_and_nothing_else_is() {
        use ratatui::buffer::Buffer;
        use ratatui::layout::Rect;

        let mut buffer = Buffer::empty(Rect::new(0, 0, 4, 1));
        let marked = format!("\u{2800}{}{}", diacritic(0), diacritic(1));
        for (x, symbol) in [
            (0, marked.as_str()),
            (1, "\u{2800}"),
            (2, "a"),
            (3, marked.as_str()),
        ] {
            if let Some(cell) = buffer.cell_mut((x, 0)) {
                let _cell = cell.set_symbol(symbol);
            }
        }
        fixup_placeholder_cells(&mut buffer, Rect::new(0, 0, 3, 1));
        let symbols: Vec<String> = (0..4)
            .map(|x| {
                buffer
                    .cell((x, 0))
                    .map_or_else(String::new, |cell| cell.symbol().to_owned())
            })
            .collect();
        assert_eq!(
            symbols,
            [
                format!("\u{10EEEE}{}{}", diacritic(0), diacritic(1)),
                "\u{2800}".to_owned(),
                "a".to_owned(),
                marked.clone(),
            ]
        );
        fixup_placeholder_cells(&mut buffer, Rect::new(2, 0, 10, 5));
        assert!(
            buffer
                .cell((3, 0))
                .is_some_and(|cell| cell.symbol().starts_with('\u{10EEEE}')),
            "clipped to the buffer"
        );
    }

    #[test]
    fn kitty_data_goes_in_chunks_that_say_whether_more_follow() {
        let mut written = Vec::new();
        let payload = "A".repeat(9000);
        transmit_kitty_data(&mut written, 7, &payload);
        let text = String::from_utf8(written).unwrap();
        let first = format!("\x1b_Ga=t,f=100,q=2,i=7,m=1;{}\x1b\\", "A".repeat(4096));
        let second = format!("\x1b_Gq=2,m=1;{}\x1b\\", "A".repeat(4096));
        let last = format!("\x1b_Gq=2,m=0;{}\x1b\\", "A".repeat(808));
        assert_eq!(text, format!("{first}{second}{last}"));

        let mut short = Vec::new();
        transmit_kitty_data(&mut short, 9, "abc");
        assert_eq!(
            String::from_utf8(short).unwrap(),
            "\x1b_Ga=t,f=100,q=2,i=9,m=0;abc\x1b\\"
        );

        let mut placed = Vec::new();
        place_kitty(&mut placed, 9, 4, 3);
        assert_eq!(
            String::from_utf8(placed).unwrap(),
            "\x1b_Ga=p,U=1,q=2,i=9,c=4,r=3\x1b\\"
        );
    }

    #[test]
    fn pictures_are_sent_as_png_converting_other_formats_first() {
        let png = encoded(3, 2, image::ImageFormat::Png);
        assert_eq!(ensure_png(&png), Some(png.clone()));
        let converted = ensure_png(&encoded(3, 2, image::ImageFormat::Jpeg)).unwrap();
        assert!(converted.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(image_dimensions(&converted), Some((3, 2)));
        assert_eq!(ensure_png(b"not a picture"), None);
        assert_eq!(base64_encode(b"hi"), "aGk=");
    }

    #[test]
    fn a_tool_result_s_pictures_are_split_from_its_text_and_named_by_their_content() {
        use sha2::{Digest as _, Sha256};

        let data = "aGVsbG8=".to_owned();
        let content = ToolResultContent::Blocks(vec![
            ContentBlock::Text {
                text: "before".to_owned(),
            },
            ContentBlock::Image {
                source: ImageSource::Base64 {
                    media_type: "image/png".to_owned(),
                    data: data.clone(),
                },
            },
            ContentBlock::Text {
                text: "after".to_owned(),
            },
        ]);
        let (text, images) = tool_result_parts(&content, "screenshot");
        assert_eq!(
            text,
            ToolResultContent::Blocks(vec![
                ContentBlock::Text {
                    text: "before".to_owned()
                },
                ContentBlock::Text {
                    text: "after".to_owned()
                },
            ])
            .display_text()
        );
        let expected_path = format!(
            "tool-image:{}",
            base64_encode(Sha256::digest(data.as_bytes()).as_slice())
        );
        let described: Vec<(String, Option<String>, Option<String>)> = images
            .into_iter()
            .map(|image| (image.path, image.caption, image.data))
            .collect();
        assert_eq!(
            described,
            [(
                expected_path,
                Some("screenshot image".to_owned()),
                Some(data)
            )]
        );

        let plain = ToolResultContent::Text("just text".to_owned());
        assert_eq!(
            tool_result_parts(&plain, "read"),
            ("just text".to_owned(), Vec::new())
        );
    }

    #[cfg(unix)]
    #[expect(
        unsafe_code,
        reason = "openpty is the only way to make a terminal of a chosen size to read back"
    )]
    fn terminal(
        cols: u16,
        rows: u16,
        xpixel: u16,
        ypixel: u16,
    ) -> (std::os::fd::OwnedFd, std::os::fd::OwnedFd) {
        use std::os::fd::FromRawFd as _;

        let mut controller_fd = -1;
        let mut follower_fd = -1;
        let mut size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: xpixel,
            ws_ypixel: ypixel,
        };
        // SAFETY: every pointer is to a live local or null, as openpty allows.
        let made = unsafe {
            libc::openpty(
                &mut controller_fd,
                &mut follower_fd,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::addr_of_mut!(size),
            )
        };
        assert_eq!(made, 0, "openpty failed");
        // SAFETY: openpty just returned this descriptor, and nothing else owns it.
        let controller = unsafe { std::os::fd::OwnedFd::from_raw_fd(controller_fd) };
        // SAFETY: openpty just returned this descriptor, and nothing else owns it.
        let follower = unsafe { std::os::fd::OwnedFd::from_raw_fd(follower_fd) };
        (controller, follower)
    }

    #[cfg(unix)]
    #[test]
    fn a_terminal_cell_is_its_pixels_over_its_grid_and_a_terminal_without_pixel_sizes_has_none() {
        let cases = [
            ((100, 30, 800, 600), Some((8, 20))),
            ((100, 30, 0, 600), None),
            ((100, 30, 800, 0), None),
            ((0, 30, 800, 600), None),
            ((100, 0, 800, 600), None),
            ((100, 30, 50, 600), None),
            ((100, 30, 800, 20), None),
        ];
        for ((cols, rows, xpixel, ypixel), expected) in cases {
            let (_controller, follower) = terminal(cols, rows, xpixel, ypixel);
            assert_eq!(
                cell_size_of(&follower),
                expected,
                "{cols}x{rows} cells over {xpixel}x{ypixel} pixels"
            );
        }
        let not_a_terminal = tempfile::tempfile().unwrap();
        assert_eq!(cell_size_of(&not_a_terminal), None);
    }

    #[cfg(unix)]
    #[test]
    #[expect(
        unsafe_code,
        reason = "only a process of its own can take a pseudo-terminal as its controlling terminal"
    )]
    fn inside_a_terminal_the_cell_size_is_read_from_it_and_probing_takes_it() {
        use std::os::fd::AsRawFd as _;
        use std::os::unix::process::CommandExt as _;

        let (_controller, follower) = terminal(100, 30, 1000, 600);
        let follower_fd = follower.as_raw_fd();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        let _configured = child
            .args([
                "--exact",
                "tui::images::tests::inside_a_terminal",
                "--ignored",
                "--nocapture",
            ])
            .env("SHORE_IMAGES", "kitty")
            .stdin(std::process::Stdio::null());
        let take_terminal = move || {
            // SAFETY: setsid is async-signal-safe and touches no memory of ours.
            if unsafe { libc::setsid() } == -1 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: ioctl is async-signal-safe, and follower_fd is still open in the child.
            if unsafe { libc::ioctl(follower_fd, libc::TIOCSCTTY, 0) } == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        };
        // SAFETY: the hook makes only async-signal-safe calls between fork and exec.
        let _in_terminal = unsafe { child.pre_exec(take_terminal) };
        let ran = child.output().unwrap();
        let printed = String::from_utf8_lossy(&ran.stdout);
        assert!(ran.status.success(), "{printed}");
        assert!(printed.contains("cell size Some((10, 20))"), "{printed}");
        assert!(printed.contains("probed Some(Kitty) (10, 2)"), "{printed}");
    }

    #[test]
    #[ignore = "only its parent test runs it, inside a terminal it made"]
    fn inside_a_terminal() {
        let mut out = std::io::stdout().lock();
        let _size = writeln!(out, "cell size {:?}", query_cell_size());
        let mut pictures = cache(8, 16);
        pictures.probe_protocol();
        let _probed = writeln!(
            out,
            "probed {:?} {:?}",
            pictures.protocol,
            pictures.calculate_cells(100, 40, 100, 50)
        );
    }

    #[test]
    fn with_no_terminal_to_ask_a_cell_is_taken_as_eight_by_sixteen_pixels() {
        if std::fs::File::open("/dev/tty").is_ok() {
            return;
        }
        assert_eq!(query_cell_size(), None);
        assert_eq!(ImageCache::new().calculate_cells(80, 32, 100, 50), (10, 2));
    }

    fn kitty() -> ImageCache {
        ImageCache {
            protocol: Some(ImageProtocol::Kitty),
            ..cache(8, 16)
        }
    }

    fn shown(sent: Option<&TransmittedImage>) -> Option<(u32, u16, u16, u32, u32)> {
        sent.map(|image| (image.id, image.cols, image.rows, image.pw, image.ph))
    }

    #[test]
    fn a_picture_is_sent_to_the_terminal_once_and_drawn_from_the_cache_after() {
        let mut pictures = kitty();
        let png = encoded(80, 32, image::ImageFormat::Png);
        let mut written = Vec::new();
        let sent = shown(pictures.transmit_once(
            "a.png",
            100,
            50,
            || Some(png.clone()),
            || Some(&mut written),
        ));
        assert_eq!(sent, Some((1, 10, 2, 80, 32)));
        let text = String::from_utf8(written).unwrap();
        assert!(
            text.starts_with(&format!(
                "\x1b_Ga=t,f=100,q=2,i=1,m=0;{}",
                base64_encode(&png)
            )),
            "{text}"
        );
        assert!(
            text.ends_with("\x1b_Ga=p,U=1,q=2,i=1,c=10,r=2\x1b\\"),
            "{text}"
        );

        let again = shown(pictures.transmit_once(
            "a.png",
            100,
            50,
            || -> Option<Vec<u8>> { panic!("read again") },
            || -> Option<Vec<u8>> { panic!("sent again") },
        ));
        assert_eq!(again, sent);
        assert_eq!(
            shown(pictures.ensure_transmitted("a.png", 1, 1)),
            sent,
            "by path, from the cache"
        );
        assert_eq!(
            shown(pictures.ensure_transmitted_from_b64("a.png", "!", 1, 1)),
            sent,
            "by key, from the cache"
        );

        let mut converted = Vec::new();
        let jpeg = encoded(16, 16, image::ImageFormat::Jpeg);
        let second =
            shown(pictures.transmit_once("b.jpg", 100, 50, || Some(jpeg), || Some(&mut converted)));
        assert_eq!(second, Some((2, 2, 1, 16, 16)), "the next id");
        let sent_png = String::from_utf8(converted).unwrap();
        let payload = sent_png
            .split_once(';')
            .and_then(|(_, rest)| rest.split_once('\x1b'))
            .map(|(data, _)| data)
            .unwrap_or_default();
        let decoded = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD
                .decode(payload)
                .unwrap()
        };
        assert!(decoded.starts_with(b"\x89PNG\r\n\x1a\n"), "sent as PNG");
        assert_eq!(image_dimensions(&decoded), Some((16, 16)));
    }

    #[test]
    fn a_picture_that_cannot_be_read_decoded_or_shown_is_not_cached() {
        let mut pictures = kitty();
        let nowhere = || None::<Vec<u8>>;
        assert!(
            pictures
                .transmit_once("gone.png", 10, 10, || None, || Some(Vec::new()))
                .is_none()
        );
        assert!(
            pictures
                .transmit_once(
                    "text.png",
                    10,
                    10,
                    || Some(b"plain".to_vec()),
                    || Some(Vec::new())
                )
                .is_none()
        );
        assert_eq!(pictures.version(), (1, 0), "nothing was even given an id");
        let png = encoded(8, 8, image::ImageFormat::Png);
        assert!(
            pictures
                .transmit_once("a.png", 10, 10, || Some(png.clone()), nowhere)
                .is_none()
        );
        assert!(pictures.get("a.png").is_none());
        assert_eq!(
            pictures.version(),
            (2, 0),
            "an id is used even with no terminal to show it on"
        );

        let mut other = cache(8, 16);
        let mut written = Vec::new();
        assert!(
            other
                .transmit_once(
                    "a.png",
                    10,
                    10,
                    || panic!("not read"),
                    || Some(&mut written)
                )
                .is_none()
        );
        assert!(
            written.is_empty(),
            "a terminal without the kitty protocol gets nothing"
        );
        assert!(other.ensure_transmitted("a.png", 10, 10).is_none());
        assert!(
            other
                .ensure_transmitted_from_b64("a.png", "aGk=", 10, 10)
                .is_none()
        );
    }

    #[test]
    fn clearing_tells_a_kitty_terminal_to_drop_its_pictures_only_when_it_has_some() {
        let mut pictures = kitty();
        let mut told = Vec::new();
        pictures.clear_on(|| Some(&mut told));
        assert!(told.is_empty(), "nothing to drop");
        let png = encoded(8, 8, image::ImageFormat::Png);
        let _sent = pictures.transmit_once("a.png", 10, 10, || Some(png), || Some(Vec::new()));
        pictures.clear_on(|| Some(&mut told));
        assert_eq!(String::from_utf8(told).unwrap(), "\x1b_Ga=d,q=2\x1b\\");
        assert!(pictures.get("a.png").is_none());

        let mut plain = cache(8, 16);
        let _previous = plain.cache.insert(
            "a.png".to_owned(),
            TransmittedImage {
                id: 1,
                cols: 1,
                rows: 1,
                pw: 1,
                ph: 1,
            },
        );
        let mut untold = Vec::new();
        plain.clear_on(|| Some(&mut untold));
        assert!(untold.is_empty(), "only a kitty terminal is told");
        assert!(plain.get("a.png").is_none());
    }

    #[test]
    fn probing_asks_for_a_protocol_only_when_none_is_known_and_keeps_the_cell_size_it_cannot_read()
    {
        let mut pictures = cache(8, 16);
        pictures.probe_with(|| Some(ImageProtocol::Kitty), || Some((10, 20)));
        assert_eq!(pictures.protocol, Some(ImageProtocol::Kitty));
        assert_eq!(pictures.calculate_cells(100, 40, 100, 50), (10, 2));
        pictures.probe_with(|| panic!("already known"), || None);
        assert_eq!(
            pictures.calculate_cells(100, 40, 100, 50),
            (10, 2),
            "an unreadable size keeps the last"
        );
    }

    #[test]
    fn the_cache_version_moves_with_each_new_picture_and_each_clear() {
        let mut pictures = cache(8, 16);
        let empty = pictures.version();
        let _previous = pictures.cache.insert(
            "a.png".to_owned(),
            TransmittedImage {
                id: 1,
                cols: 1,
                rows: 1,
                pw: 1,
                ph: 1,
            },
        );
        pictures.next_id = 2;
        let one = pictures.version();
        assert_ne!(one, empty);
        assert!(pictures.get("a.png").is_some());
        pictures.clear();
        assert!(pictures.get("a.png").is_none());
        assert_ne!(pictures.version(), one);
        pictures.next_id = 3;
        assert_ne!(
            pictures.version(),
            empty,
            "a later picture after a clear is still new"
        );
    }
}
