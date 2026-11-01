export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Semaphore limit must be an integer >= 1, got ${limit}`);
    }
    this.available = limit;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw new Error("Aborted before acquiring semaphore slot");
    }
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.queue.indexOf(grant);
        if (index !== -1) {
          this.queue.splice(index, 1);
        }
        reject(new Error("Aborted while waiting for semaphore slot"));
      };
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve(() => this.release());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(grant);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}

export async function runWithSemaphore<T>(
  semaphore: Semaphore,
  items: readonly T[],
  task: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  await Promise.all(
    items.map(async (item, index) => {
      const release = await semaphore.acquire(signal);
      try {
        await task(item, index);
      } finally {
        release();
      }
    }),
  );
}
