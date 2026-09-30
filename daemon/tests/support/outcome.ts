export async function outcomeOf<T>(promise: T | PromiseLike<T>): Promise<() => T> {
  try {
    const value = await promise;
    return () => value;
  } catch (error) {
    return () => {
      throw error;
    };
  }
}

export async function rejectionOf(promise: unknown): Promise<unknown> {
  let value: unknown;
  try {
    value = await promise;
  } catch (error) {
    return error;
  }
  throw new Error(`Expected promise that rejects\nReceived promise that resolved: ${Bun.inspect(value)}`);
}
