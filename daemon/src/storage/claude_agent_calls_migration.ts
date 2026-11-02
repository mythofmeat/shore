import { isSubscriptionProvider } from "../ledger/store.ts";
import { shoreLog } from "../log.ts";
import { pack, withStorage } from "./store.ts";

const DONE = "shore/claude-agent-calls-from-before-its-subscription-default";

const PROVIDER = "claude_agent";

export function markOldClaudeAgentCallsAsSubscription(data: string): void {
  try {
    const marked = withStorage(data, (db) => {
      if (db.query("SELECT 1 FROM state_files WHERE path = ?1").get(DONE) !== null) return 0;
      return db.transaction(() => {
        const unpriced = db.query("SELECT DISTINCT character FROM calls WHERE provider = ?1 AND total_cost IS NULL")
          .all(PROVIDER) as { character: string }[];
        const mark = db.query(
          "UPDATE calls SET cost_source = 'subscription', total_cost = 0 WHERE provider = ?1 AND character = ?2 AND total_cost IS NULL",
        );
        const changed = unpriced
          .filter(({ character }) => isSubscriptionProvider(PROVIDER, character))
          .reduce((total, { character }) => total + mark.run(PROVIDER, character).changes, 0);
        db.query("INSERT INTO state_files(path, character, content) VALUES (?1, '', ?2) ON CONFLICT(path) DO NOTHING").run(DONE, pack("done"));
        return changed;
      })();
    });
    if (marked > 0) {
      shoreLog.info(`shore: recorded ${String(marked)} old ${PROVIDER} calls that had no cost as subscription calls at $0; this happens once`);
    }
  } catch (error) {
    shoreLog.warn(`shore: could not record old ${PROVIDER} calls as subscription calls, so they stay unpriced until a later start succeeds: ${String(error)}`);
  }
}
