import { AsyncLocalStorage } from "node:async_hooks";

export interface ProviderEvent {
  type: "provider_event";
  provider: string;
  event: unknown;
}

type ProviderEventSink = (event: ProviderEvent) => void;

const sinks = new AsyncLocalStorage<ProviderEventSink>();

export function recordProviderEvent(provider: string, event: unknown): void {
  try {
    sinks.getStore()?.({ type: "provider_event", provider, event });
  } catch {
  }
}

export function withProviderEvents<T>(sink: ProviderEventSink, run: () => T): T {
  return sinks.run(sink, run);
}

export async function* providerEventIteration<T>(
  sink: ProviderEventSink,
  start: () => AsyncIterable<T>,
): AsyncIterable<T> {
  const iterator = withProviderEvents(sink, () => start()[Symbol.asyncIterator]());
  try {
    for (;;) {
      const step = await withProviderEvents(sink, () => iterator.next());
      if (step.done === true) return;
      yield step.value;
    }
  } finally {
    await withProviderEvents(sink, () => iterator.return?.(undefined));
  }
}
