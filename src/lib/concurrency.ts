/** Run an async mapper over items with a bounded number of in-flight tasks. */
export async function pooledMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  onTick?: (done: number, total: number) => void,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const total = items.length;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
      done++;
      onTick?.(done, total);
    }
  }

  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return out;
}
