#!/usr/bin/env python3
"""Mutation pass over what a stopped Matrix bot leaves behind (#271).

`matrix-js-sdk`'s `stopClient()` cancels what is already scheduled and nothing
else. Two things in the SDK outlive it, in 42.4.0 and still in 43.0.0:

- `CapabilityPoller.poll()` schedules its next run when its fetch settles
  (30-35s after a failure, six hours after a success) without checking whether
  it was stopped meanwhile. A client stopped mid-fetch polls `/capabilities`
  for the rest of the process's life. A start that fails against a homeserver
  that is down stops the client mid-fetch (twelve times out of twelve against
  a closed port), so each of the supervisor's retries left another poller
  behind.
- `timeoutSignal()` arms a timer for every request with a local timeout and
  never clears it. Every `/sync` has one of 80-110s, so a process that ran the
  bridge against a perfectly healthy homeserver could not exit for up to 110s
  after it was stopped. Upstream has had this open since 2022, as
  matrix-org/matrix-js-sdk#2472.

The daemon exits when its event loop drains, so either one kept a stopped
daemon alive. Patching the dependency is not an option here: `bun patch` keys a
patch to one exact version and `bun update --latest` drops it with a warning,
which the scheduled dependency update would do on the SDK's next release.

So the bot takes over what the SDK gets wrong: what its client may still send
and hear once it has stopped, and the timers on its requests. That is
`src/connections/matrix/client.ts`, and every mutant below takes a piece of it
away while leaving a bot that starts, syncs and sends as before.

**The line out.** The client's `fetch` carries the bot's stop signal. Stopping
hangs up on whatever is in flight and refuses whatever is asked afterwards.

**What a stopped client hears.** Nothing. A request that ends after the stop
never reports how it ended, because every retry the SDK schedules is scheduled
from the continuation of a request. This is what stops the poller, and it would
stop another like it.

**Timeouts.** A request's local timeout is a timer the bot starts and clears
with the request, in place of the SDK's.

**The bot's own waits.** A client that hears nothing would leave the bot's own
`await`s hanging, so each one gives up when the bot stops: a send, a redaction,
a login, the wait for the first sync.

**The supervisor.** Stopping reaches an attempt that is still in flight instead
of waiting for the homeserver, and a bridge that comes up after the stop was
asked for is stopped rather than left running.

Each group runs against the one test file that watches it, because a mutant
here shows up as a hung test and a hung test costs its whole timeout. The last
group is what only a draining event loop can catch: `tests/matrix_shutdown.test.ts`
starts real processes and takes ten seconds to notice each one that lingers.

A mutant is KILLED if its group's tests fail with it applied.

Run from the repository root:
    python3 daemon/scripts/mutate_matrix_stop.py
"""
import sys

C = "src/connections/matrix/client.ts"
B = "src/connections/matrix/bot.ts"
A = "src/connections/matrix/start.ts"
S = "src/connections/matrix/supervise.ts"

# (label, file, find, replace)
CLIENT = [
    # --- the line out ---------------------------------------------------------
    ("line: the client keeps the global fetch, so stopping hangs up on nothing",
     C,
     "createClient({ ...options, fetchFn: fetchUntil(stopSignal) })",
     "createClient(options)"),
    ("line: a request answers to the stop signal alone, so nothing else can end it",
     C,
     "signal: eitherSignal(init?.signal, stopSignal)",
     "signal: stopSignal"),
    ("line: a request answers to its own signal alone, so stopping leaves it in flight",
     C,
     "signal: eitherSignal(init?.signal, stopSignal)",
     "signal: init?.signal ?? null"),

    # --- what a stopped client hears ------------------------------------------
    ("silence: a request in flight at the stop still reports how it ended",
     C,
     "  } finally {\n    if (stopSignal.aborted) await neverSettles();\n  }",
     "  } finally {\n  }"),
    ("silence: a stopped client still goes through the motions of a request",
     C,
     "  if (stopSignal.aborted) return await neverSettles();\n",
     ""),

    # --- timeouts -------------------------------------------------------------
    ("timeout: the timer goes off and aborts nothing",
     C,
     "setTimeout(() => timeout.abort(), localTimeoutMs)",
     "setTimeout(() => {}, localTimeoutMs)"),
    ("timeout: a request with a timeout no longer answers to its caller's signal",
     C,
     "abortSignal: eitherSignal(untimed.abortSignal, timeout.signal),",
     "abortSignal: timeout.signal,"),
]

BOT = [
    # --- the bot's own waits --------------------------------------------------
    ("stop: the client is stopped and the bot's requests are left alone",
     B,
     "  stop(): void {\n    this.#stopController.abort();\n  }",
     "  stop(): void {\n    this.#shutDown();\n  }"),
    ("wait: a stop is not raced against what the bot is waiting for",
     B,
     "    return await Promise.race([ask(), stopped.promise]);",
     "    return await ask();"),
    ("wait: a bot already stopped still asks",
     B,
     "  stopSignal.throwIfAborted();\n  const stopped = abortRejection(stopSignal);",
     "  const stopped = abortRejection(stopSignal);"),
    ("wait: a start waits for the homeserver's first answer whatever happens",
     B,
     "await this.#whileRunning(() => this.#client.startClient({ initialSyncLimit: 0 }));",
     "await this.#client.startClient({ initialSyncLimit: 0 });"),
    ("wait: a send waits for the homeserver whatever happens",
     B,
     "      const sent = await this.#whileRunning(() =>\n"
     "        this.#client.sendEvent(roomId, EventType.RoomMessage, content as never),\n"
     "      );",
     "      const sent = await this.#client.sendEvent(roomId, EventType.RoomMessage, content as never);"),
    ("wait: a redaction waits for the homeserver whatever happens",
     B,
     "      await this.#whileRunning(() =>\n"
     "        this.#client.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined),\n"
     "      );",
     "      await this.#client.redactEvent(roomId, eventId, undefined, reason ? { reason } : undefined);"),
    ("wait: a typing notice waits for the homeserver whatever happens",
     B,
     "      await this.#whileRunning(() =>\n"
     "        this.#client.sendTyping(roomId, typing, typing ? TYPING_TIMEOUT_MS : 0),\n"
     "      );",
     "      await this.#client.sendTyping(roomId, typing, typing ? TYPING_TIMEOUT_MS : 0);"),
    ("wait: an image upload waits for the homeserver whatever happens",
     B,
     "      const upload = await this.#whileRunning(() =>\n"
     "        this.#client.uploadContent(new Uint8Array(bytes), { name, type: mimeType }),\n"
     "      );",
     "      const upload = await this.#client.uploadContent(new Uint8Array(bytes), { name, type: mimeType });"),
    ("wait: a display name waits for the homeserver whatever happens",
     B,
     "await this.#whileRunning(() => this.#client.setDisplayName(character));",
     "await this.#client.setDisplayName(character);"),
    ("wait: an avatar waits for the homeserver whatever happens",
     B,
     "      await this.#whileRunning(async () => {\n"
     "        const upload = await this.#client.uploadContent(avatar.bytes, { type: avatar.mimeType });\n"
     "        await this.#client.setAvatarUrl(upload.content_uri);\n"
     "      });",
     "      const upload = await this.#client.uploadContent(avatar.bytes, { type: avatar.mimeType });\n"
     "      await this.#client.setAvatarUrl(upload.content_uri);"),
    ("wait: a room alias lookup waits for the homeserver whatever happens",
     B,
     "(await this.#whileRunning(() => this.#client.getRoomIdForAlias(alias))).room_id",
     "(await this.#client.getRoomIdForAlias(alias)).room_id"),
    ("wait: a password login waits for the homeserver whatever happens",
     B,
     "      const session = await unlessStopped(stopSignal, () =>\n"
     "        client.loginRequest({",
     "      const session = await ((_stop: AbortSignal, ask: () => ReturnType<typeof client.loginRequest>) => ask())(stopSignal, () =>\n"
     "        client.loginRequest({"),
    ("media: a download outlives the bot",
     B,
     "signal: AbortSignal.any([this.#stopSignal, AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS)]),",
     "signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),"),
    ("media: a download the stop cut short is reported as a timeout",
     B,
     "      if (!this.#stopSignal.aborted && isTimeoutError(e)) {",
     "      if (isTimeoutError(e)) {"),

    # --- the signal a bot is given --------------------------------------------
    ("signal: the bot ignores the signal it was given",
     B,
     "        : AbortSignal.any([stopController.signal, config.signal]);",
     "        : stopController.signal;"),
    ("signal: only the bot's own stop stops its client and ends its event stream",
     B,
     'stopSignal.addEventListener("abort", () => this.#shutDown(), { once: true });',
     'stopController.signal.addEventListener("abort", () => this.#shutDown(), { once: true });'),
    ("signal: a bot is logged in after its signal has aborted",
     B,
     "    config.signal?.throwIfAborted();\n",
     ""),
]

SYNC_WAIT = [
    ("sync wait: a stop is not listened for",
     B,
     '    stopSignal?.addEventListener("abort", onStop, { once: true });\n',
     ""),
    ("sync wait: a bot already stopped waits anyway",
     B,
     "    if (stopSignal?.aborted === true) {\n      onStop();\n      return;\n    }\n",
     ""),
]

SUPERVISOR = [
    ("attempt: the supervisor's signal never reaches the login",
     A,
     "      ...(stopSignal === undefined ? {} : { signal: stopSignal }),\n",
     ""),
    ("attempt: a start the stop abandoned is reported as a failure",
     A,
     "    if (stopSignal?.aborted !== true) options.log?.warn?.(",
     "    options.log?.warn?.("),
    ("supervisor: stopping waits for the attempt in flight",
     S,
     "      stopController.abort();\n",
     ""),
    ("supervisor: a bridge that comes up during the stop is left running",
     S,
     "      if (stopped) {\n        await outcome.handle.stop();\n        return;\n      }\n",
     ""),
]

EVENT_LOOP = [
    ("timeout: the SDK times the request out, with a timer it never clears",
     C,
     "  if (options?.localTimeoutMs === undefined) return await request<T>(method, url, body, options);",
     "  if (request !== undefined) return await request<T>(method, url, body, options);"),
    ("timeout: the bot's own timer is left running after its request ends",
     C,
     "  } finally {\n    clearTimeout(timer);\n  }",
     "  } finally {\n  }"),
    ("stop: the SDK client is never told to stop, so what it scheduled still runs",
     B,
     "  #shutDown(): void {\n    this.#client.stopClient();\n",
     "  #shutDown(): void {\n"),
    ("start: a bot that failed to start is left running",
     B,
     "    } catch (e) {\n      this.stop();\n      throw e;\n    }",
     "    } catch (e) {\n      throw e;\n    }"),
    ("start: the wait for the first sync does not hear the stop",
     B,
     "await awaitInitialSync(this.#client, SYNC_START_TIMEOUT_MS, this.#stopSignal);",
     "await awaitInitialSync(this.#client, SYNC_START_TIMEOUT_MS);"),
]

GROUPS = [
    (CLIENT, ["tests/matrix_client.test.ts"]),
    (BOT, ["tests/matrix_bot.test.ts"]),
    (SYNC_WAIT, ["tests/matrix_sync_start.test.ts"]),
    (SUPERVISOR, ["tests/matrix_supervise.test.ts"]),
    (EVENT_LOOP, ["tests/matrix_shutdown.test.ts"]),
]


from mutation import run as _run_mutants  # noqa: E402


def main() -> int:
    return max(_run_mutants(mutants, tests) for mutants, tests in GROUPS)


if __name__ == "__main__":
    sys.exit(main())
