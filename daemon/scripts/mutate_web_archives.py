#!/usr/bin/env python3
"""Exercise controlled archive transfer ownership, lifecycle, bounds and recovery."""
import sys
from mutation import run

A = "src/web/archives.ts"
C = "src/commands/archive.ts"
MUTANTS = [
    ("another sign-in can use an artifact handle", A,
     'record.owner.id !== owner.id || ', ''),
    ("another sign-in can enumerate uploads", A,
     'record.owner.id === owner.id && !record.abort.signal.aborted', '!record.abort.signal.aborted'),
    ("browser filenames become daemon paths", A,
     'return join(directory, "archive.tar.gz");', 'return join(directory, record.info.filename);'),
    ("uploaded archives are readable by other local users", A,
     '"wx", 0o600', '"wx", 0o644'),
    ("an import can be replayed after its outcome is known", A,
     'record.info.phase !== "ready" || record.info.downloadable', 'record.info.downloadable'),
    ("active imports can lose their tracked outcome", A,
     '["uploading", "exporting", "importing"].includes(record.info.phase) || record.downloading', 'record.downloading'),
    ("chunked uploads evade their byte limit", A,
     'if (bytes > this.#limits.uploadBytes)', 'if (false)'),
    ("uploads reserve no disk capacity", A,
     'reserved: this.#limits.uploadBytes,', 'reserved: 0,'),
    ("archive workers have no concurrency bound", A,
     'this.#commands >= 1 || !this.canAttach()', '!this.canAttach()'),
    ("timeouts become confirmed failures instead of uncertain imports", A,
     'name === "import_character" && !(error instanceof ConfirmedArchiveFailure) ? "uncertain" : "failed"', '"failed"'),
    ("completion without a result is accepted", A,
     'if (frame.outcome !== "completed" || !received)', 'if (false)'),
    ("wrong-name and duplicate archive outputs are accepted", A,
     'if (received || frame.name !== name)', 'if (false)'),
    ("download follows a substituted symlink", A,
     'constants.O_RDONLY | constants.O_NOFOLLOW', 'constants.O_RDONLY'),
    ("completed downloads retain temporary exports", A,
     'if (complete) await this.#remove(record);', 'void complete;'),
    ("logout retains transfer artifacts", A,
     'owner.signal.addEventListener("abort", expire, { once: true });', 'void expire;'),
    ("archive worker loads an unrelated conversation", A,
     'character: null, capabilities: ["request-lifecycle"]', 'capabilities: ["request-lifecycle"]'),
    ("browser archives accept unsupported link entries", C,
     '!("type" in entry) || !["File", "OldFile", "Directory"].includes(entry.type) || ', ''),
    ("browser extraction ignores its expanded size budget", C,
     '(limits?.bytes ?? MAX_EXTRACTED_BYTES)', 'MAX_EXTRACTED_BYTES'),
    ("export skips its database snapshot budget", "src/storage/archive.ts",
     'if (pageCount.page_count * pageSize.page_size > maxBytes)', 'if (false)'),
    ("shared dispatch drops trusted browser processing limits", "src/handler/commands.ts",
     'limits: meta.session.archiveLimits', 'limits: undefined'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/web_archives.test.ts", "tests/archive.test.ts", "tests/command_path.test.ts"]))
