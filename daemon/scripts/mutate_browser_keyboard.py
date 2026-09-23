#!/usr/bin/env python3
"""Exercise saved browser shortcuts, typing scopes and sensitive presets."""
import sys
from mutation import run

P = "src/browser/keyboard.ts"
MUTANTS = [
    ("uppercase loses shift", P, 'parts.push("shift")', 'parts.push()'),
    ("duplicate modifiers accepted", P, 'new Set(parts).size !== parts.length', 'false'),
    ("reserved shortcuts rebound", P, 'if (reservedKey(key))', 'if (false)'),
    ("typing permits unmodified letters", P, 'record["scope"] === "global" &&', 'false &&'),
    ("argument bound measures characters", P, 'new TextEncoder().encode(JSON.stringify(result)).length', 'JSON.stringify(result).length'),
    ("normal bindings interrupt typing", P, 'item.scope === "global" || !editing', 'true'),
    ("dialogs lose their keys", P, 'modal && binding?.target !== "request:cancel"', 'false'),
    ("dialogs suppress cancellation", P, 'modal && binding?.target !== "request:cancel"', 'modal'),
    ("global binding priority lost", P, 'candidates.find((item) => item.scope === "global") ?? candidates[0]', 'candidates[0]'),
    ("operation arguments skip canonical validation", P, 'binding.mode === "run" && (!isOperationName(name) || !validOperationInput(name, binding.args))', 'false'),
    ("message templates skip canonical validation", P, 'conversationRequest(name, binding.args);', '{}'),
    ("secret configuration presets allowed", P, 'entry === undefined || entry.secret', 'entry === undefined'),
    ("unknown configuration presets allowed", P, 'entry === undefined || entry.secret', 'entry?.secret'),
    ("configuration arguments require no schema", P, 'if (schema === undefined) throw new Error("Wait for the configuration schema before saving arguments");', 'if (schema === undefined) return;'),
    ("view targets omitted", P, '...Object.entries(VIEW_CONTROLS).map', '...[].map'),
    ("default removal lost on reload", P, 'if (value === null) values.delete(id);', 'if (value === null) {}'),
    ("custom removal accumulates records", P, 'this.storage.removeItem(KEYBOARD_STORAGE + id)', 'this.storage.setItem(KEYBOARD_STORAGE + id, "null")'),
    ("failed writes lost during cross-tab reload", P, 'for (const [id, binding] of this.#dirty) { if (binding === null) values.delete(id); else values.set(id, binding); }', ''),
    ("new binding is not persisted", P, 'this.#dirty.set(id, binding);', ''),
    ("repaired storage retains its error", P, 'this.#dirty.size === 0 ? "" : this.#state.error', 'this.#state.error'),
    ("active binding count not bounded", P, 'bindings.length >= MAX_BINDINGS', 'false'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/browser_keyboard.test.ts"]))
