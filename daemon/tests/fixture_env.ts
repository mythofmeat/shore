import { afterEach } from "bun:test";

import { restoreTestEnv } from "./support/env.ts";
import { testRunRoot } from "./support/tmp.ts";

const LONGEST_TIMER_DELAY_MS = 2 ** 31 - 1;

function giveTheEventLoopATimerToSleepOn(): void {
  setInterval(() => {}, LONGEST_TIMER_DELAY_MS);
}

process.env["USER"] = "peggy";
process.env["TMPDIR"] = testRunRoot();

giveTheEventLoopATimerToSleepOn();

afterEach(restoreTestEnv);
