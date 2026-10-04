#!/usr/bin/env python3
"""Exercise persistent sign-in and archive restart boundaries."""
import sys
from mutation import run

A = "src/web/archives.ts"
R = "src/web/recovery.ts"
S = "src/web/auth.ts"
MUTANTS = [
    ("import begins before its durable record", A,
     'this.recovery?.saveArchive(owner.id, { ...record.info, phase: "importing" });', ''),
    ("interrupted import becomes ready for replay", A,
     'info.phase = "uncertain"; info.error = "The daemon stopped', 'info.phase = "ready"; info.error = "The daemon stopped'),
    ("temporary archive files survive a crash", R,
     'rmSync(this.artifacts, { recursive: true, force: true });', ''),
    ("token rotation keeps previous browser credentials", R,
     'JSON.stringify([1, origin, options.token])', 'JSON.stringify([1, origin])'),
    ("origin change keeps previous browser credentials", R,
     'JSON.stringify([1, origin, options.token])', 'JSON.stringify([1, options.token])'),
    ("shutdown revokes restart recovery", S,
     'clearTimeout(session.timer);', 'this.revoke(session); clearTimeout(session.timer);'),
    ("logout is not durable", S,
     'this.recovery?.revokeSession(session.id);', ''),
    ("a renewed sign-in reverts to its old expiry after a restart", S,
     'this.recovery?.renewSession(stored.id, expiresAt);', ''),
    ("another browser's cookie renews a sign-in", S,
     ' || sessionDigest(token) !== stored.id', ''),
    ("recovered credentials extend their expiry", S,
     'this.#restore(saved.id, saved.expires_at)', 'this.#restore(saved.id, Date.now() + lifetime)'),
    ("restore keeps expired transfer outcomes", A,
     'owner === undefined || saved.info.expires_at <= Date.now()', 'owner === undefined'),
    ("recovery ignores session capacity", S,
     'this.#sessions.size < capacity && ', ''),
    ("data directories share browser recovery", R,
     'sessionDigest(realpathSync(options.dataDir))', '"shared"'),
    ("recovery database follows a symlink", R,
     'constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW', 'constants.O_CREAT | constants.O_RDWR'),
    ("browser worker loses owned staging", A,
     ', temporaryDirectory: await record.directory', ''),
    ("archive extraction escapes owned staging", "src/commands/archive.ts",
     'ctx.limits?.temporaryDirectory ?? tmpdir(), "shore-import-"', 'tmpdir(), "shore-import-"'),
    ("archive snapshot escapes owned staging", "src/commands/archive.ts",
     'ctx.limits?.temporaryDirectory ?? tmpdir(), "shore-export-"', 'tmpdir(), "shore-export-"'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/web_recovery.test.ts", "tests/web_archives.test.ts", "tests/archive.test.ts"]))
