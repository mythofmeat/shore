import { usageTotals } from "./query.ts";
import { ledgerFor } from "./record.ts";

export interface ConversationTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export const noTokens = (): ConversationTokens => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
});

export function conversationTokens(
  ledgerPath: string | undefined,
  character: string,
  startedAt: string | undefined,
): ConversationTokens {
  if (ledgerPath === undefined || startedAt === undefined) return noTokens();
  const ledger = ledgerFor(ledgerPath);
  if (ledger === null) return noTokens();
  const totals = usageTotals(ledger.database, { character, since: startedAt });
  return {
    input: totals.total_input,
    output: totals.total_output,
    cache_read: totals.total_cache_read,
    cache_write: totals.total_cache_write,
  };
}
