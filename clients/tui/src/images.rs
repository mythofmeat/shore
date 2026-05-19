use std::collections::HashMap;
use std::io::Write;

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};

pub use shore_swp_client::image_protocol::detect_protocol as detect_protocol_from_env;
pub use shore_swp_client::image_protocol::detect_protocol_probe;
pub use shore_swp_client::image_protocol::ImageProtocol;

pub type KittyImageId = u32;

/// An image that has been transmitted to the terminal and is ready for display.
pub struct TransmittedImage {
    pub id: KittyImageId,
    pub cols: u16,
    pub rows: u16,
    /// Original pixel width of the source image.
    pub pw: u32,
    /// Original pixel height of the source image.
    pub ph: u32,
}

/// Cache of transmitted images, keyed by file path.
pub struct ImageCache {
    next_id: u32,
    cache: HashMap<String, TransmittedImage>,
    protocol: Option<ImageProtocol>,
    cell_width: u16,
    cell_height: u16,
}

/// Open `/dev/tty` for writing.
///
/// Kitty graphics APC sequences must bypass stdout to avoid interleaving
/// with ratatui/crossterm output. Writing to `/dev/tty` sends escape
/// sequences directly to the terminal, matching how `probe_kitty_graphics`
/// communicates.
fn open_tty_write() -> Option<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/tty")
        .ok()
}

/// Query the terminal for cell pixel dimensions via TIOCGWINSZ.
/// Returns (cell_width, cell_height) or None if unavailable.
#[cfg(unix)]
fn query_cell_size() -> Option<(u16, u16)> {
    use std::os::unix::io::AsRawFd;
    let tty = std::fs::File::open("/dev/tty").ok()?;
    let fd = tty.as_raw_fd();

    // winsize struct: rows, cols, xpixel, ypixel (all u16)
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, &mut ws) };
    if ret != 0 || ws.ws_xpixel == 0 || ws.ws_ypixel == 0 || ws.ws_col == 0 || ws.ws_row == 0 {
        return None;
    }
    let cw = ws.ws_xpixel / ws.ws_col;
    let ch = ws.ws_ypixel / ws.ws_row;
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

/// Ensure image data is PNG-encoded for kitty `f=100` transmission.
/// Returns the data unchanged if already PNG, otherwise decodes and re-encodes as PNG.
fn ensure_png(data: &[u8]) -> Option<Vec<u8>> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(data.to_vec());
    }
    let img = image::load_from_memory(data).ok()?;
    let mut png_buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut png_buf, image::ImageFormat::Png).ok()?;
    Some(png_buf.into_inner())
}

// Kitty Unicode placeholder diacritics table (values 0-255).
// Each entry is a combining diacritical mark codepoint.
// Source: kitty gen/rowcolumn-diacritics.txt
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
    pub fn new() -> Self {
        let (cw, ch) = query_cell_size().unwrap_or((8, 16));
        Self {
            next_id: 1,
            cache: HashMap::new(),
            protocol: detect_protocol_from_env(),
            cell_width: cw,
            cell_height: ch,
        }
    }

    /// Re-detect protocol using terminal probe (requires raw mode).
    /// Also refreshes cell pixel dimensions.
    pub fn probe_protocol(&mut self) {
        if self.protocol.is_none() {
            self.protocol = detect_protocol_probe();
        }
        if let Some((cw, ch)) = query_cell_size() {
            self.cell_width = cw;
            self.cell_height = ch;
        }
    }

    /// Transmit an image to kitty if not already cached.
    /// Returns a reference to the cached image on success.
    pub fn ensure_transmitted(
        &mut self,
        path: &str,
        max_cols: u16,
        max_rows: u16,
    ) -> Option<&TransmittedImage> {
        if self.protocol != Some(ImageProtocol::Kitty) {
            return None;
        }
        if self.cache.contains_key(path) {
            return self.cache.get(path);
        }

        let data = std::fs::read(path).ok()?;
        let (pw, ph) = image_dimensions(&data)?;
        let (cols, rows) = self.calculate_cells(pw, ph, max_cols, max_rows);

        let id = self.next_id;
        self.next_id += 1;

        let png_data = ensure_png(&data)?;
        let encoded = base64_encode(&png_data);
        let mut tty = open_tty_write()?;
        transmit_kitty_data(&mut tty, id, &encoded);
        place_kitty(&mut tty, id, cols, rows);
        let _ = tty.flush();

        self.cache.insert(
            path.to_string(),
            TransmittedImage {
                id,
                cols,
                rows,
                pw,
                ph,
            },
        );
        self.cache.get(path)
    }

    /// Transmit an image from base64 data if not already cached.
    /// Uses `key` (typically the server path) as the cache key.
    pub fn ensure_transmitted_from_b64(
        &mut self,
        key: &str,
        b64_data: &str,
        max_cols: u16,
        max_rows: u16,
    ) -> Option<&TransmittedImage> {
        if self.protocol != Some(ImageProtocol::Kitty) {
            return None;
        }
        if self.cache.contains_key(key) {
            return self.cache.get(key);
        }

        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64_data)
            .ok()?;
        let (pw, ph) = image_dimensions(&bytes)?;
        let (cols, rows) = self.calculate_cells(pw, ph, max_cols, max_rows);

        let id = self.next_id;
        self.next_id += 1;

        let png_data = ensure_png(&bytes)?;
        let encoded = base64_encode(&png_data);
        let mut tty = open_tty_write()?;
        transmit_kitty_data(&mut tty, id, &encoded);
        place_kitty(&mut tty, id, cols, rows);
        let _ = tty.flush();

        self.cache.insert(
            key.to_string(),
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

    /// Look up a previously transmitted image.
    pub fn get(&self, path: &str) -> Option<&TransmittedImage> {
        self.cache.get(path)
    }

    /// Cheap fingerprint of cache state, used as a cache-invalidation key
    /// by the renderer. `next_id` is monotonic across the cache's lifetime
    /// (insertions only ever bump it), so combined with `cache.len()` it
    /// uniquely identifies "the set of images currently visible."
    pub fn version(&self) -> u64 {
        ((self.next_id as u64) << 32) | (self.cache.len() as u64)
    }

    /// Delete all transmitted images and clear the cache.
    pub fn clear(&mut self) {
        if self.protocol == Some(ImageProtocol::Kitty) && !self.cache.is_empty() {
            if let Some(mut tty) = open_tty_write() {
                let _ = write!(tty, "\x1b_Ga=d,q=2\x1b\\");
                let _ = tty.flush();
            }
        }
        self.cache.clear();
    }

    pub fn calculate_cells(&self, pw: u32, ph: u32, max_cols: u16, max_rows: u16) -> (u16, u16) {
        let cw = self.cell_width as f64;
        let ch = self.cell_height as f64;

        // Scale to fit width
        let natural_cols = pw as f64 / cw;
        let cols_f = natural_cols.min(max_cols as f64).max(1.0);
        let scale_w = (cols_f * cw) / pw as f64;
        let rows_from_w = (ph as f64 * scale_w / ch).ceil();

        // If height exceeds cap, scale to fit height instead
        let (cols, rows) = if rows_from_w > max_rows as f64 {
            let scale_h = (max_rows as f64 * ch) / ph as f64;
            let cols_from_h = (pw as f64 * scale_h / cw).floor().max(1.0);
            (cols_from_h as u16, max_rows)
        } else {
            (cols_f as u16, rows_from_w as u16)
        };

        (cols.max(1), rows.clamp(1, 255))
    }
}

/// Generate ratatui Lines containing kitty Unicode placeholder stand-ins.
///
/// Uses U+2800 (Braille Blank, width 1) instead of U+10EEEE (width 2 per
/// `unicode-width`) so that ratatui allocates exactly one cell per placeholder.
/// After rendering, call [`fixup_placeholder_cells`] to swap U+2800 → U+10EEEE
/// before the frame is flushed.
pub fn placeholder_lines(img: &TransmittedImage) -> Vec<Line<'static>> {
    let style = id_to_style(img.id);
    let mut lines = Vec::with_capacity(img.rows as usize);
    for row in 0..img.rows {
        let mut text = String::with_capacity(img.cols as usize * 12);
        for col in 0..img.cols {
            // U+2800 is a width-1 stand-in for U+10EEEE (width-2 per unicode-width).
            // Row/col diacritics are kept as-is — they combine with the base char.
            text.push('\u{2800}');
            text.push(diacritic(row as u8));
            text.push(diacritic(col as u8));
        }
        lines.push(Line::from(Span::styled(text, style)));
    }
    lines
}

/// Generate placeholder lines for an image at arbitrary cell dimensions.
/// Used for fullscreen display where dimensions differ from the cached inline size.
pub fn placeholder_lines_at(id: KittyImageId, cols: u16, rows: u16) -> Vec<Line<'static>> {
    let style = id_to_style(id);
    let mut lines = Vec::with_capacity(rows as usize);
    for row in 0..rows {
        let mut text = String::with_capacity(cols as usize * 12);
        for col in 0..cols {
            text.push('\u{2800}');
            text.push(diacritic(row as u8));
            text.push(diacritic(col as u8));
        }
        lines.push(Line::from(Span::styled(text, style)));
    }
    lines
}

/// Replace U+2800 stand-in characters with U+10EEEE kitty placeholders in a
/// rendered buffer. Must be called after Paragraph renders but before the
/// frame is flushed to the terminal.
pub fn fixup_placeholder_cells(buf: &mut ratatui::buffer::Buffer, area: ratatui::layout::Rect) {
    for y in area.y..(area.y + area.height) {
        for x in area.x..(area.x + area.width) {
            let cell = &buf[(x, y)];
            let sym = cell.symbol();
            if let Some(rest) = sym.strip_prefix('\u{2800}') {
                if !rest.is_empty() {
                    let mut new_sym = String::with_capacity(4 + rest.len());
                    new_sym.push('\u{10EEEE}');
                    new_sym.push_str(rest);
                    buf[(x, y)].set_symbol(&new_sym);
                }
            }
        }
    }
}

fn diacritic(value: u8) -> char {
    // Safety: all DIACRITICS entries are valid Unicode code points
    char::from_u32(DIACRITICS[value as usize]).unwrap()
}

fn id_to_style(id: u32) -> Style {
    if id < 256 {
        Style::default().fg(Color::Indexed(id as u8))
    } else {
        let r = (id & 0xFF) as u8;
        let g = ((id >> 8) & 0xFF) as u8;
        let b = ((id >> 16) & 0xFF) as u8;
        Style::default().fg(Color::Rgb(r, g, b))
    }
}

/// Transmit image data to kitty (a=t: transmit only, no display).
/// Uses chunked base64 transfer with `f=100` (PNG). Only valid for PNG data.
fn transmit_kitty_data<W: Write>(w: &mut W, id: u32, encoded: &str) {
    const CHUNK_SIZE: usize = 4096;
    let chunks: Vec<&str> = encoded
        .as_bytes()
        .chunks(CHUNK_SIZE)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect();

    for (i, chunk) in chunks.iter().enumerate() {
        let more = if i + 1 < chunks.len() { 1 } else { 0 };
        if i == 0 {
            let _ = write!(w, "\x1b_Ga=t,f=100,q=2,i={id},m={more};{chunk}\x1b\\");
        } else {
            let _ = write!(w, "\x1b_Gq=2,m={more};{chunk}\x1b\\");
        }
    }
}

/// Create a virtual placement for Unicode placeholder rendering.
fn place_kitty<W: Write>(w: &mut W, id: u32, cols: u16, rows: u16) {
    let _ = write!(w, "\x1b_Ga=p,U=1,q=2,i={id},c={cols},r={rows}\x1b\\");
}

/// Parse image dimensions from raw file bytes (PNG, JPEG, WebP).
fn image_dimensions(data: &[u8]) -> Option<(u32, u32)> {
    // PNG: magic + IHDR
    if data.len() >= 24 && data.starts_with(b"\x89PNG\r\n\x1a\n") {
        let w = u32::from_be_bytes([data[16], data[17], data[18], data[19]]);
        let h = u32::from_be_bytes([data[20], data[21], data[22], data[23]]);
        return Some((w, h));
    }
    // JPEG: scan for SOF0/SOF2 marker
    if data.len() >= 4 && data[0] == 0xFF && data[1] == 0xD8 {
        let mut i = 2;
        while i + 9 < data.len() {
            if data[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = data[i + 1];
            if marker == 0xC0 || marker == 0xC2 {
                let h = u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32;
                let w = u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32;
                return Some((w, h));
            }
            if i + 3 < data.len() {
                let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
                i += 2 + len;
            } else {
                break;
            }
        }
    }
    // WebP
    if data.len() >= 30 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        if &data[12..16] == b"VP8 " {
            let w = (u16::from_le_bytes([data[26], data[27]]) & 0x3FFF) as u32;
            let h = (u16::from_le_bytes([data[28], data[29]]) & 0x3FFF) as u32;
            return Some((w, h));
        }
        if &data[12..16] == b"VP8L" && data.len() >= 25 {
            let b = u32::from_le_bytes([data[21], data[22], data[23], data[24]]);
            let w = (b & 0x3FFF) + 1;
            let h = ((b >> 14) & 0x3FFF) + 1;
            return Some((w, h));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use shore_swp_client::image_protocol::detect_protocol_from_env as detect_protocol;

    #[test]
    fn detect_kitty_from_env() {
        assert_eq!(
            detect_protocol(Some("kitty"), None, None, false, false),
            Some(ImageProtocol::Kitty)
        );
    }

    #[test]
    fn detect_iterm_from_term_program() {
        assert_eq!(
            detect_protocol(None, Some("iTerm.app"), None, false, false),
            Some(ImageProtocol::Iterm2)
        );
    }

    #[test]
    fn detect_kitty_from_term() {
        assert_eq!(
            detect_protocol(None, None, Some("xterm-kitty"), false, false),
            Some(ImageProtocol::Kitty)
        );
    }

    #[test]
    fn detect_none() {
        assert_eq!(
            detect_protocol(None, None, Some("xterm-256color"), false, false),
            None
        );
    }

    #[test]
    fn detect_ghostty_from_term_program() {
        assert_eq!(
            detect_protocol(None, Some("ghostty"), None, false, false),
            Some(ImageProtocol::Kitty)
        );
    }

    #[test]
    fn detect_ghostty_from_env_var() {
        // GHOSTTY_RESOURCES_DIR survives tmux/zellij
        assert_eq!(
            detect_protocol(None, None, Some("xterm-256color"), true, false),
            Some(ImageProtocol::Kitty)
        );
    }

    #[test]
    fn detect_kitty_from_window_id() {
        // KITTY_WINDOW_ID survives tmux/zellij
        assert_eq!(
            detect_protocol(None, None, Some("xterm-256color"), false, true),
            Some(ImageProtocol::Kitty)
        );
    }

    #[test]
    fn detect_off() {
        assert_eq!(detect_protocol(Some("off"), None, None, false, false), None);
    }

    #[test]
    fn kitty_transmit_data_format() {
        let mut buf = Vec::new();
        transmit_kitty_data(&mut buf, 42, "AAAA");
        let out = String::from_utf8(buf).unwrap();
        assert!(out.contains("\x1b_Ga=t,f=100,q=2,i=42,m=0;AAAA\x1b\\"));
    }

    #[test]
    fn kitty_place_format() {
        let mut buf = Vec::new();
        place_kitty(&mut buf, 42, 10, 5);
        let out = String::from_utf8(buf).unwrap();
        assert_eq!(out, "\x1b_Ga=p,U=1,q=2,i=42,c=10,r=5\x1b\\");
    }

    #[test]
    fn placeholder_dimensions() {
        let img = TransmittedImage {
            id: 1,
            cols: 3,
            rows: 2,
            pw: 24,
            ph: 32,
        };
        let lines = placeholder_lines(&img);
        assert_eq!(lines.len(), 2);
        // Each line should have one span with 3 placeholder cells
        // Each cell = U+10EEEE (4 bytes) + 2 combining chars
        for line in &lines {
            assert_eq!(line.spans.len(), 1);
        }
    }

    #[test]
    fn placeholder_encoding() {
        let img = TransmittedImage {
            id: 5,
            cols: 2,
            rows: 1,
            pw: 160,
            ph: 80,
        };
        let lines = placeholder_lines(&img);
        let text = &lines[0].spans[0].content;
        // First cell: U+2800 stand-in + diacritic(0) + diacritic(0)
        let chars: Vec<char> = text.chars().collect();
        assert_eq!(chars[0], '\u{2800}'); // stand-in (fixup replaces with U+10EEEE)
        assert_eq!(chars[1], diacritic(0)); // row 0
        assert_eq!(chars[2], diacritic(0)); // col 0
        assert_eq!(chars[3], '\u{2800}');
        assert_eq!(chars[4], diacritic(0)); // row 0
        assert_eq!(chars[5], diacritic(1)); // col 1
    }

    #[test]
    fn fixup_replaces_standin() {
        use ratatui::buffer::Buffer;
        use ratatui::layout::Rect;

        let img = TransmittedImage {
            id: 5,
            cols: 2,
            rows: 1,
            pw: 160,
            ph: 80,
        };
        let lines = placeholder_lines(&img);
        let area = Rect::new(0, 0, 10, 1);
        let mut buf = Buffer::empty(area);
        let para = ratatui::widgets::Paragraph::new(ratatui::text::Text::from(lines));
        ratatui::widgets::Widget::render(para, area, &mut buf);

        // Before fixup: cells contain U+2800
        assert!(buf[(0, 0)].symbol().starts_with('\u{2800}'));

        fixup_placeholder_cells(&mut buf, area);

        // After fixup: cells contain U+10EEEE
        assert!(buf[(0, 0)].symbol().starts_with('\u{10EEEE}'));
        assert!(buf[(1, 0)].symbol().starts_with('\u{10EEEE}'));
    }

    #[test]
    fn diacritic_values() {
        assert_eq!(diacritic(0), '\u{0305}');
        assert_eq!(diacritic(1), '\u{030D}');
        assert_eq!(diacritic(2), '\u{030E}');
    }

    #[test]
    fn id_style_indexed() {
        let style = id_to_style(42);
        assert_eq!(style.fg, Some(Color::Indexed(42)));
    }

    #[test]
    fn id_style_rgb() {
        let style = id_to_style(256);
        assert_eq!(style.fg, Some(Color::Rgb(0, 1, 0)));
    }

    #[test]
    fn png_dimensions() {
        // Minimal PNG header for a 100x50 image
        let mut data = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        data.extend_from_slice(&[0, 0, 0, 13]); // IHDR length
        data.extend_from_slice(b"IHDR");
        data.extend_from_slice(&100u32.to_be_bytes()); // width
        data.extend_from_slice(&50u32.to_be_bytes()); // height
        assert_eq!(image_dimensions(&data), Some((100, 50)));
    }

    #[test]
    fn calculate_cells_fits() {
        let cache = ImageCache {
            next_id: 1,
            cache: HashMap::new(),
            protocol: Some(ImageProtocol::Kitty),
            cell_width: 8,
            cell_height: 16,
        };
        // 160x80 image at 8x16 cell size = 20 cols x 5 rows
        let (cols, rows) = cache.calculate_cells(160, 80, 60, 30);
        assert_eq!(cols, 20);
        assert_eq!(rows, 5);
    }

    #[test]
    fn calculate_cells_clamped() {
        let cache = ImageCache {
            next_id: 1,
            cache: HashMap::new(),
            protocol: Some(ImageProtocol::Kitty),
            cell_width: 8,
            cell_height: 16,
        };
        // 800x400 image, max 40 cols: scaled to 40 cols
        let (cols, rows) = cache.calculate_cells(800, 400, 40, 30);
        assert_eq!(cols, 40);
        // scale = 40*8/800 = 0.4, rows = ceil(400*0.4/16) = ceil(10) = 10
        assert_eq!(rows, 10);
    }

    #[test]
    fn calculate_cells_height_clamped() {
        let cache = ImageCache {
            next_id: 1,
            cache: HashMap::new(),
            protocol: Some(ImageProtocol::Kitty),
            cell_width: 8,
            cell_height: 16,
        };
        // 800x3200 image, max 60 cols, max 10 rows
        // Width-first: natural = 100 cols, clamped to 60, scale = 60*8/800 = 0.6
        //   rows_from_w = ceil(3200*0.6/16) = ceil(120) = 120 → exceeds max_rows=10
        // Height-first: scale_h = 10*16/3200 = 0.05
        //   cols_from_h = floor(800*0.05/8) = floor(5.0) = 5
        let (cols, rows) = cache.calculate_cells(800, 3200, 60, 10);
        assert_eq!(rows, 10);
        assert_eq!(cols, 5);
    }
}
