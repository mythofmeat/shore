//! Prompt template upgrade manifest.
//!
//! Tracks SHA-256 hashes of default templates so the daemon can auto-update
//! stock templates without clobbering user edits. See §11.1 of ARCHITECTURE.md.
//!
//! Only the **global** prompts directory (`$XDG_CONFIG_HOME/shore/prompts/`) is
//! tracked. Per-character overrides (`characters/{character}/prompts/`) are
//! always user-managed and never appear in the manifest.

use chrono::Local;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// A single template's tracking entry in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TemplateEntry {
    /// SHA-256 hash of the template content when last written by the daemon.
    pub hash: String,
    /// ISO-8601 timestamp of when the template was last written.
    pub updated_at: String,
}

/// The on-disk manifest (`prompts.manifest.json`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptManifest {
    pub version: u32,
    pub templates: HashMap<String, TemplateEntry>,
}

impl Default for PromptManifest {
    fn default() -> Self {
        Self {
            version: 1,
            templates: HashMap::new(),
        }
    }
}

/// A built-in default template shipped with the binary.
#[derive(Debug, Clone)]
pub struct DefaultTemplate {
    /// Filename (e.g. `"system.md"`).
    pub name: String,
    /// Template content.
    pub content: String,
}

/// What happened to a single template during sync.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateAction {
    /// Template didn't exist — wrote default and recorded hash.
    Written,
    /// Template existed, hash matched manifest — overwrote with new default.
    Updated,
    /// Template existed, hash didn't match manifest — user modified, left alone.
    UserModified,
    /// Template existed but wasn't in manifest — pre-manifest file, left alone.
    PreManifest,
}

/// Report of what happened during a [`sync_templates`] run.
#[derive(Debug, Clone, Default)]
pub struct SyncReport {
    pub actions: Vec<(String, TemplateAction)>,
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/// Compute the SHA-256 hash of `content`, returning a `"sha256:<hex>"` string.
pub fn sha256_hex(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    let result = hasher.finalize();
    format!("sha256:{result:x}")
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

impl PromptManifest {
    /// Load the manifest from a JSON file.
    ///
    /// Returns a default (empty) manifest if the file doesn't exist.
    pub fn load(path: &Path) -> io::Result<Self> {
        match fs::read_to_string(path) {
            Ok(content) => serde_json::from_str(&content)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e),
        }
    }

    /// Save the manifest to a JSON file, creating parent directories as needed.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(io::Error::other)?;
        fs::write(path, json)
    }
}

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

/// Synchronize default templates to disk, respecting user edits.
///
/// For each default template the decision table is:
///
/// | File exists? | In manifest? | Hash matches? | Action                          |
/// |:---:|:---:|:---:|----|
/// | No  | —   | —   | Write default, record hash      |
/// | Yes | Yes | Yes | Overwrite with new default       |
/// | Yes | Yes | No  | User modified — leave alone      |
/// | Yes | No  | —   | Pre-manifest file — leave alone  |
///
/// Only operates on the global prompts directory. Per-character overrides are
/// never tracked.
pub fn sync_templates(
    prompts_dir: &Path,
    manifest_path: &Path,
    defaults: &[DefaultTemplate],
) -> io::Result<SyncReport> {
    let mut manifest = PromptManifest::load(manifest_path)?;
    let mut report = SyncReport::default();

    fs::create_dir_all(prompts_dir)?;

    for template in defaults {
        let file_path = prompts_dir.join(&template.name);
        let action =
            sync_one_template(&file_path, &template.name, &template.content, &mut manifest)?;
        report.actions.push((template.name.clone(), action));
    }

    manifest.save(manifest_path)?;
    Ok(report)
}

fn sync_one_template(
    file_path: &Path,
    name: &str,
    default_content: &str,
    manifest: &mut PromptManifest,
) -> io::Result<TemplateAction> {
    let file_exists = file_path.exists();
    let in_manifest = manifest.templates.contains_key(name);

    if !file_exists {
        // Template doesn't exist → write default, record hash.
        write_template(file_path, default_content, name, manifest)?;
        Ok(TemplateAction::Written)
    } else if !in_manifest {
        // File exists but not in manifest → pre-manifest, treat as user-managed.
        Ok(TemplateAction::PreManifest)
    } else {
        // File exists and in manifest — check hash.
        let current_content = fs::read(file_path)?;
        let current_hash = sha256_hex(&current_content);
        let manifest_hash = manifest
            .templates
            .get(name)
            .map(|entry| entry.hash.as_str())
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "template missing from manifest")
            })?;

        if current_hash == manifest_hash {
            // Hash matches → user hasn't touched it → overwrite with new default.
            write_template(file_path, default_content, name, manifest)?;
            Ok(TemplateAction::Updated)
        } else {
            // Hash doesn't match → user modified → leave alone.
            Ok(TemplateAction::UserModified)
        }
    }
}

fn write_template(
    file_path: &Path,
    content: &str,
    name: &str,
    manifest: &mut PromptManifest,
) -> io::Result<()> {
    fs::write(file_path, content)?;
    let hash = sha256_hex(content.as_bytes());
    let _ignored = manifest.templates.insert(
        name.to_owned(),
        TemplateEntry {
            hash,
            updated_at: Local::now().to_rfc3339(),
        },
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Default path helpers
// ---------------------------------------------------------------------------

/// Returns the default manifest path: `$SHORE_DATA_DIR/prompts.manifest.json`.
pub fn default_manifest_path() -> PathBuf {
    shore_common::config::data_dir().join("prompts.manifest.json")
}

/// Returns the default global prompts directory: `$SHORE_CONFIG_DIR/prompts/`.
pub fn default_prompts_dir() -> PathBuf {
    shore_common::config::config_dir().join("prompts")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_defaults() -> Vec<DefaultTemplate> {
        vec![
            DefaultTemplate {
                name: "system.md".to_owned(),
                content: "You are {{character_name}}.".to_owned(),
            },
            DefaultTemplate {
                name: "compact.md".to_owned(),
                content: "Summarize: {{conversation}}".to_owned(),
            },
        ]
    }

    fn item<T>(values: &[T], index: usize) -> &T {
        values.get(index).expect("value item")
    }

    fn template_entry<'manifest>(
        manifest: &'manifest PromptManifest,
        name: &str,
    ) -> &'manifest TemplateEntry {
        manifest
            .templates
            .get(name)
            .unwrap_or_else(|| panic!("missing template entry {name}"))
    }

    // -- Manifest serialization / deserialization -----------------------------

    #[test]
    fn test_manifest_round_trip() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("manifest.json");

        let mut manifest = PromptManifest::default();
        let _ignored = manifest.templates.insert(
            "system.md".to_owned(),
            TemplateEntry {
                hash: "sha256:abc123".to_owned(),
                updated_at: "2026-03-25T00:00:00Z".to_owned(),
            },
        );

        manifest.save(&path).unwrap();
        let loaded = PromptManifest::load(&path).unwrap();
        assert_eq!(manifest, loaded);
    }

    #[test]
    fn test_manifest_load_missing_returns_default() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("nonexistent.json");
        let manifest = PromptManifest::load(&path).unwrap();
        assert_eq!(manifest, PromptManifest::default());
    }

    #[test]
    fn test_manifest_creates_parent_dirs() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("nested").join("deep").join("manifest.json");

        let manifest = PromptManifest::default();
        manifest.save(&path).unwrap();
        assert!(path.exists());
    }

    // -- Scenario 1: template doesn't exist → write default, record hash -----

    #[test]
    fn test_sync_writes_missing_template() {
        let dir = tempfile::TempDir::new().unwrap();
        let prompts = dir.path().join("prompts");
        let manifest_path = dir.path().join("manifest.json");
        let defaults = make_defaults();

        let report = sync_templates(&prompts, &manifest_path, &defaults).unwrap();

        assert_eq!(report.actions.len(), 2);
        assert_eq!(
            item(&report.actions, 0),
            &("system.md".to_owned(), TemplateAction::Written)
        );
        assert_eq!(
            item(&report.actions, 1),
            &("compact.md".to_owned(), TemplateAction::Written)
        );

        // Files exist with correct content.
        assert_eq!(
            fs::read_to_string(prompts.join("system.md")).unwrap(),
            "You are {{character_name}}."
        );
        assert_eq!(
            fs::read_to_string(prompts.join("compact.md")).unwrap(),
            "Summarize: {{conversation}}"
        );

        // Manifest records hashes.
        let manifest = PromptManifest::load(&manifest_path).unwrap();
        assert!(manifest.templates.contains_key("system.md"));
        assert!(manifest.templates.contains_key("compact.md"));
        assert!(template_entry(&manifest, "system.md")
            .hash
            .starts_with("sha256:"));
        assert_eq!(
            template_entry(&manifest, "system.md").hash.as_str(),
            sha256_hex(b"You are {{character_name}}.")
        );
    }

    // -- Scenario 2: template exists, hash matches → overwrite with new default

    #[test]
    fn test_sync_updates_unchanged_template() {
        let dir = tempfile::TempDir::new().unwrap();
        let prompts = dir.path().join("prompts");
        let manifest_path = dir.path().join("manifest.json");

        // First sync: write v1 defaults.
        let defaults_v1 = vec![DefaultTemplate {
            name: "system.md".to_owned(),
            content: "Version 1".to_owned(),
        }];
        let _ignored = sync_templates(&prompts, &manifest_path, &defaults_v1).unwrap();
        assert_eq!(
            fs::read_to_string(prompts.join("system.md")).unwrap(),
            "Version 1"
        );

        // Second sync with upgraded v2 default.
        let defaults_v2 = vec![DefaultTemplate {
            name: "system.md".to_owned(),
            content: "Version 2".to_owned(),
        }];
        let report = sync_templates(&prompts, &manifest_path, &defaults_v2).unwrap();

        assert_eq!(
            item(&report.actions, 0),
            &("system.md".to_owned(), TemplateAction::Updated)
        );
        assert_eq!(
            fs::read_to_string(prompts.join("system.md")).unwrap(),
            "Version 2"
        );

        // Manifest hash updated to v2 content.
        let manifest = PromptManifest::load(&manifest_path).unwrap();
        assert_eq!(
            template_entry(&manifest, "system.md").hash.as_str(),
            sha256_hex(b"Version 2")
        );
    }

    // -- Scenario 3: template exists, hash doesn't match → user modified -----

    #[test]
    fn test_sync_preserves_user_modified_template() {
        let dir = tempfile::TempDir::new().unwrap();
        let prompts = dir.path().join("prompts");
        let manifest_path = dir.path().join("manifest.json");

        // First sync.
        let defaults = vec![DefaultTemplate {
            name: "system.md".to_owned(),
            content: "Default content".to_owned(),
        }];
        let _ignored = sync_templates(&prompts, &manifest_path, &defaults).unwrap();

        // User edits the template.
        fs::write(prompts.join("system.md"), "My custom prompt").unwrap();

        // Second sync — should leave user's version alone.
        let report = sync_templates(&prompts, &manifest_path, &defaults).unwrap();
        assert_eq!(
            item(&report.actions, 0),
            &("system.md".to_owned(), TemplateAction::UserModified)
        );
        assert_eq!(
            fs::read_to_string(prompts.join("system.md")).unwrap(),
            "My custom prompt"
        );
    }

    // -- Scenario 4: template exists, not in manifest → pre-manifest ---------

    #[test]
    fn test_sync_preserves_pre_manifest_template() {
        let dir = tempfile::TempDir::new().unwrap();
        let prompts = dir.path().join("prompts");
        let manifest_path = dir.path().join("manifest.json");

        // Create a template file before any sync (simulates pre-manifest install).
        fs::create_dir_all(&prompts).unwrap();
        fs::write(prompts.join("system.md"), "Pre-manifest content").unwrap();

        let defaults = vec![DefaultTemplate {
            name: "system.md".to_owned(),
            content: "Default content".to_owned(),
        }];
        let report = sync_templates(&prompts, &manifest_path, &defaults).unwrap();

        assert_eq!(
            item(&report.actions, 0),
            &("system.md".to_owned(), TemplateAction::PreManifest)
        );
        assert_eq!(
            fs::read_to_string(prompts.join("system.md")).unwrap(),
            "Pre-manifest content"
        );

        // Manifest should NOT contain this template.
        let manifest = PromptManifest::load(&manifest_path).unwrap();
        assert!(!manifest.templates.contains_key("system.md"));
    }

    // -- SHA-256 hashing -----------------------------------------------------

    #[test]
    fn test_sha256_hex_known_value() {
        let hash = sha256_hex(b"hello");
        assert_eq!(
            hash,
            "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }

    #[test]
    fn test_sha256_hex_different_inputs() {
        let h1 = sha256_hex(b"hello");
        let h2 = sha256_hex(b"world");
        assert_ne!(h1, h2);
    }

    #[test]
    fn test_sha256_hex_empty() {
        let hash = sha256_hex(b"");
        assert!(hash.starts_with("sha256:"));
        // SHA-256 of empty string is well-known.
        assert_eq!(
            hash,
            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
