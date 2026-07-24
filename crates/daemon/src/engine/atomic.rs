use std::io::Write;
use std::path::Path;

use crate::engine::EngineError;

/// Write `data` to `path` atomically via temp-file + rename.
pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> Result<(), EngineError> {
    let dir = path.parent().ok_or_else(|| EngineError::Io {
        path: path.to_path_buf(),
        source: std::io::Error::new(std::io::ErrorKind::InvalidInput, "no parent directory"),
    })?;

    std::fs::create_dir_all(dir).map_err(|e| EngineError::Io {
        path: dir.to_path_buf(),
        source: e,
    })?;

    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| EngineError::Io {
        path: dir.to_path_buf(),
        source: e,
    })?;

    tmp.write_all(data).map_err(|e| EngineError::Io {
        path: path.to_path_buf(),
        source: e,
    })?;

    let _ignored = tmp.persist(path).map_err(|e| EngineError::Io {
        path: path.to_path_buf(),
        source: e.error,
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn atomic_write_creates_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.jsonl");
        atomic_write(&path, b"hello\nworld\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello\nworld\n");
    }

    #[test]
    fn atomic_write_replaces_existing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.jsonl");
        std::fs::write(&path, "old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    }
}
