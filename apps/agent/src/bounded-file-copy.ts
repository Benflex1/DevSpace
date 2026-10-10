/** Runs independent file-copy operations with explicit count and byte bounds. */
export class BoundedFileCopyQueue {
  private readonly active = new Set<Promise<void>>();
  private inFlightBytes = 0;
  private failure: { readonly error: unknown } | null = null;

  constructor(
    private readonly maxActiveCopies: number,
    private readonly maxInFlightBytes: number
  ) {
    if (!Number.isInteger(maxActiveCopies) || maxActiveCopies < 1) {
      throw new RangeError("maxActiveCopies must be a positive integer");
    }
    if (!Number.isSafeInteger(maxInFlightBytes) || maxInFlightBytes < 1) {
      throw new RangeError("maxInFlightBytes must be a positive safe integer");
    }
  }

  async schedule(fileBytes: number, copy: () => Promise<void>): Promise<void> {
    if (!Number.isSafeInteger(fileBytes) || fileBytes < 0 || fileBytes > this.maxInFlightBytes) {
      throw new RangeError("fileBytes must fit within the in-flight byte bound");
    }
    this.throwIfFailed();
    while (this.active.size >= this.maxActiveCopies || this.inFlightBytes + fileBytes > this.maxInFlightBytes) {
      await Promise.race(this.active);
      this.throwIfFailed();
    }
    this.throwIfFailed();

    this.inFlightBytes += fileBytes;
    const task = Promise.resolve()
      .then(copy)
      .catch((error: unknown) => {
        this.failure ??= { error };
      })
      .finally(() => {
        this.active.delete(task);
        this.inFlightBytes -= fileBytes;
      });
    this.active.add(task);
  }

  async settle(): Promise<void> {
    while (this.active.size > 0) await Promise.all(this.active);
  }

  assertHealthy(): void {
    this.throwIfFailed();
  }

  async drain(): Promise<void> {
    await this.settle();
    this.throwIfFailed();
  }

  private throwIfFailed(): void {
    if (this.failure !== null) throw this.failure.error;
  }
}
