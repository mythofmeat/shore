#!/usr/bin/env python3
"""Exercise usage filters, mode precedence and complete report metadata."""
import sys
from mutation import run

SOURCE = "src/ledger/usage.ts"
MUTANTS = [
    ("character filters are dropped", SOURCE,
     'character: str(args, "character"),', 'character: undefined,'),
    ("provider filters are dropped", SOURCE,
     'provider: str(args, "provider"),', 'provider: undefined,'),
    ("API key name filters are dropped", SOURCE,
     'api_key_name: str(args, "api_key"),', 'api_key_name: undefined,'),
    ("model filters are dropped", SOURCE,
     'model: str(args, "model"),', 'model: undefined,'),
    ("call type filters are dropped", SOURCE,
     'call_type: str(args, "call_type"),', 'call_type: undefined,'),
    ("budget mode loses precedence", SOURCE,
     'if (flag(args, "budget")) {', 'if (false) {'),
    ("TSV mode loses precedence", SOURCE,
     'if (flag(args, "export_tsv")) {', 'if (false) {'),
    ("CSV mode loses precedence", SOURCE,
     'if (flag(args, "export_csv")) {', 'if (false) {'),
    ("grouping disappears", SOURCE,
     'if (dimension !== undefined) {', 'if (false) {'),
    ("anomaly mode disappears", SOURCE,
     'if (flag(args, "anomalies")) {', 'if (false) {'),
    ("stored rate limits disappear", SOURCE,
     'request.rateLimits?.() ?? [],', '[],'),
    ("subscription quota disappears", SOURCE,
     'nanogpt_subscription: nanoGptSubscription ?? null,', 'nanogpt_subscription: null,'),
    ("unsettled calls disappear from summary", SOURCE,
     'nanogpt_subscription: nanoGptSubscription ?? null,\n    call_attempts: callAttemptStatus(db),',
     'nanogpt_subscription: nanoGptSubscription ?? null,'),
    ("ledger absence is hidden from discovery", "src/commands/registry.ts",
     'ledger: (context) => context.deps.ledgerPath !== undefined,', 'ledger: () => true,'),
]

if __name__ == "__main__":
    sys.exit(run(MUTANTS, ["tests/commands_usage.test.ts", "tests/ledger_usage.test.ts", "tests/ledger_usage_cases.test.ts", "tests/operation_contracts.test.ts"]))
