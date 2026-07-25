use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use shore_common::protocol::types::Message;
use tracing::debug;

use super::EngineError;

/// Metadata for a single frozen segment file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentEntry {
    pub file: String,
    pub message_count: usize,
    pub compacted_at: String,
}

/// Tracks compacted segments for a character's conversation history.
///
/// Persisted at `$XDG_DATA_HOME/shore/{character}/compaction.json`.
/// Absent means no compaction has happened yet.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CompactionManifest {
    pub segments: Vec<SegmentEntry>,
    pub total_compacted_messages: usize,
}

/// Read-only access to frozen conversation segments.
///
/// Segments are created by compaction: older messages are moved out of
/// `active.jsonl` into numbered JSONL files under `segments/`. Each
/// segment is immutable after creation.
#[derive(Debug)]
pub struct SegmentReader {
    segments_dir: PathBuf,
    manifest: CompactionManifest,
}

impl SegmentReader {
    /// Load segment metadata from a character directory.
    ///
    /// Reads `compaction.json` if present; otherwise starts empty.
    pub fn load(character_dir: &Path) -> Result<Self, EngineError> {
        let manifest_path = character_dir.join(shore_common::config::COMPACTION_MANIFEST_FILE);
        let segments_dir = character_dir.join(shore_common::config::SEGMENTS_DIR);

        let manifest = if manifest_path.exists() {
            debug!(path = %manifest_path.display(), "loading compaction manifest");
            let content = std::fs::read_to_string(&manifest_path).map_err(|e| EngineError::Io {
                path: manifest_path.clone(),
                source: e,
            })?;
            let m: CompactionManifest =
                serde_json::from_str(&content).map_err(|e| EngineError::JsonParse {
                    path: manifest_path,
                    source: e,
                })?;
            debug!(
                segments = m.segments.len(),
                total_compacted = m.total_compacted_messages,
                "compaction manifest loaded"
            );
            m
        } else {
            CompactionManifest::default()
        };

        Ok(Self {
            segments_dir,
            manifest,
        })
    }

    /// Number of frozen segments.
    pub fn segment_count(&self) -> usize {
        self.manifest.segments.len()
    }

    /// Total number of messages across all frozen segments.
    pub fn total_message_count(&self) -> usize {
        self.manifest.total_compacted_messages
    }

    /// Load messages from a specific segment by index.
    pub fn read_segment(&self, index: usize) -> Result<Vec<Message>, EngineError> {
        let entry = self
            .manifest
            .segments
            .get(index)
            .ok_or_else(|| EngineError::MessageNotFound(format!("segment index {index}")))?;

        let path = self.segments_dir.join(&entry.file);
        let content = std::fs::read_to_string(&path).map_err(|e| EngineError::Io {
            path: path.clone(),
            source: e,
        })?;

        let mut msgs = Vec::new();
        for raw_line in content.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            let mut msg: Message =
                serde_json::from_str(line).map_err(|e| EngineError::JsonParse {
                    path: path.clone(),
                    source: e,
                })?;
            msg.normalize();
            msgs.push(msg);
        }
        Ok(msgs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_without_compaction_json_gives_empty() {
        let tmp = TempDir::new().unwrap();
        let reader = SegmentReader::load(tmp.path()).unwrap();
        assert_eq!(reader.segment_count(), 0);
        assert_eq!(reader.total_message_count(), 0);
    }

    #[test]
    fn load_with_compaction_json() {
        let tmp = TempDir::new().unwrap();
        let manifest = CompactionManifest {
            segments: vec![SegmentEntry {
                file: "0001.jsonl".into(),
                message_count: 10,
                compacted_at: "2026-03-26T00:00:00Z".into(),
            }],
            total_compacted_messages: 10,
        };
        let json = serde_json::to_string_pretty(&manifest).unwrap();
        std::fs::write(tmp.path().join("compaction.json"), &json).unwrap();

        let reader = SegmentReader::load(tmp.path()).unwrap();
        assert_eq!(reader.segment_count(), 1);
        assert_eq!(reader.total_message_count(), 10);
    }

    #[test]
    fn read_segment_loads_messages() {
        let tmp = TempDir::new().unwrap();
        let seg_dir = tmp.path().join("segments");
        std::fs::create_dir_all(&seg_dir).unwrap();

        // Write a segment file.
        let msg_json = r#"{"msg_id":"m1","role":"user","content":"old message","images":[],"timestamp":"2026-01-01T00:00:00Z"}"#;
        std::fs::write(seg_dir.join("0001.jsonl"), format!("{msg_json}\n")).unwrap();

        let manifest = CompactionManifest {
            segments: vec![SegmentEntry {
                file: "0001.jsonl".into(),
                message_count: 1,
                compacted_at: "2026-03-26T00:00:00Z".into(),
            }],
            total_compacted_messages: 1,
        };
        let json = serde_json::to_string_pretty(&manifest).unwrap();
        std::fs::write(tmp.path().join("compaction.json"), &json).unwrap();

        let reader = SegmentReader::load(tmp.path()).unwrap();
        let msgs = reader.read_segment(0).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].msg_id, "m1");
        assert_eq!(msgs[0].content, "old message");
    }

    #[test]
    fn read_segment_out_of_bounds() {
        let tmp = TempDir::new().unwrap();
        let reader = SegmentReader::load(tmp.path()).unwrap();
        assert!(reader.read_segment(0).is_err());
    }
}
