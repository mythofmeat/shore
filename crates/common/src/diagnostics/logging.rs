use std::fmt;

use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields, FormattedFields};
use tracing_subscriber::registry::LookupSpan;

/// Single-line formatter for service logs.
///
/// The default tracing formatter puts span context before the event message,
/// which makes journald output hard to scan once spans carry several fields.
/// This keeps the same core data visible but moves the human sentence first:
///
/// `LEVEL target: message | fields: key=value ... | spans: name{field=value}`
#[derive(Debug, Default, Clone, Copy)]
pub struct HumanLogFormat;

impl<S, N> FormatEvent<S, N> for HumanLogFormat
where
    S: Subscriber + for<'span> LookupSpan<'span>,
    N: for<'span> FormatFields<'span> + 'static,
{
    fn format_event(
        &self,
        ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let metadata = event.metadata();
        let mut fields = EventFields::default();
        event.record(&mut fields);

        write!(
            writer,
            "{:<5} {}: {}",
            metadata.level(),
            metadata.target(),
            fields.message.as_deref().unwrap_or(metadata.name())
        )?;

        if !fields.fields.is_empty() {
            write!(writer, " | fields: ")?;
            write_field_pairs(&mut writer, fields.fields.iter())?;
        }

        let spans = span_context(ctx)?;
        if !spans.is_empty() {
            write!(writer, " | spans: {}", spans.join(" > "))?;
        }

        writeln!(writer)
    }
}

fn span_context<S, N>(ctx: &FmtContext<'_, S, N>) -> Result<Vec<String>, fmt::Error>
where
    S: Subscriber + for<'span> LookupSpan<'span>,
    N: for<'span> FormatFields<'span> + 'static,
{
    let mut spans = Vec::new();
    ctx.visit_spans(|span| {
        let mut rendered = span.name().to_owned();
        let ext = span.extensions();
        // Formatted fields are normally populated by the subscriber on
        // new_span, but absence is not worth panicking over inside a log
        // formatter — fall back to rendering just the span name.
        if let Some(fields) = ext.get::<FormattedFields<N>>() {
            if !fields.is_empty() {
                rendered.push('{');
                rendered.push_str(fields);
                rendered.push('}');
            }
        }
        spans.push(rendered);
        Ok(())
    })?;
    Ok(spans)
}

fn write_field_pairs<'span>(
    writer: &mut Writer<'_>,
    fields: impl Iterator<Item = &'span (String, String)>,
) -> fmt::Result {
    let mut first = true;
    for (name, value) in fields {
        if !first {
            write!(writer, " ")?;
        }
        first = false;
        write!(writer, "{name}={value}")?;
    }
    Ok(())
}

#[derive(Default)]
struct EventFields {
    message: Option<String>,
    fields: Vec<(String, String)>,
}

impl EventFields {
    fn push(&mut self, field: &Field, value: String) {
        if field.name() == "message" {
            self.message = Some(value);
        } else {
            self.fields.push((field.name().to_owned(), value));
        }
    }
}

impl Visit for EventFields {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.push(field, format!("{value:?}"));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_owned());
        } else {
            self.push(field, format!("{value:?}"));
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.push(field, value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.push(field, value.to_string());
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        self.push(field, value.to_string());
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        self.push(field, value.to_string());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.push(field, value.to_string());
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.push(field, value.to_string());
    }

    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.push(field, value.to_string());
    }
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::sync::{Arc, Mutex};

    use tracing_subscriber::fmt::MakeWriter;

    use super::*;

    #[test]
    fn human_log_format_keeps_fields_and_spans_after_message() {
        let output = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .event_format(HumanLogFormat)
            .with_writer(BufferWriter(Arc::clone(&output)))
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!(
                "generate",
                character = "qifei",
                model = "anthropic/claude-opus-4.6",
                call_type = "keepalive"
            );
            let _entered = span.enter();
            tracing::warn!(
                status = 403_u16,
                body_len = 196_usize,
                body_preview = r#"{"error":{"message":"Key limit exceeded"}}"#,
                "LLM API returned error status"
            );
        });

        let raw = String::from_utf8(output.lock().unwrap().clone()).unwrap();
        // tracing-subscriber's DefaultFields formatter emits ANSI escapes around
        // span field names regardless of writer TTY-ness; strip them so the
        // assertions are stable across environments.
        let rendered = strip_ansi(&raw);
        assert!(rendered.starts_with(
            "WARN  shore_common::diagnostics::logging::tests: LLM API returned error status"
        ));
        assert!(rendered.contains("fields: status=403 body_len=196 body_preview="));
        assert!(rendered.contains(
            r#"spans: generate{character="qifei" model="anthropic/claude-opus-4.6" call_type="keepalive"}"#
        ));
    }

    fn strip_ansi(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            if c == '\x1b' && chars.as_str().starts_with('[') {
                let _ignored = chars.next();
                for inner in chars.by_ref() {
                    if inner.is_ascii_alphabetic() {
                        break;
                    }
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    #[derive(Clone)]
    struct BufferWriter(Arc<Mutex<Vec<u8>>>);

    impl<'span> MakeWriter<'span> for BufferWriter {
        type Writer = Buffer;

        fn make_writer(&'span self) -> Self::Writer {
            Buffer(Arc::clone(&self.0))
        }
    }

    struct Buffer(Arc<Mutex<Vec<u8>>>);

    impl io::Write for Buffer {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .map_err(|_| io::Error::other("log buffer mutex poisoned"))?
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
}
