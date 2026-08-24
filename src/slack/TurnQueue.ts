/**
 * Serialises agent turns.
 *
 * Two guarantees, both required for correctness rather than politeness:
 *  1. **Per thread**: two turns must never run against the same session directory, or they
 *     interleave writes into one session file and corrupt the conversation.
 *  2. **Globally**: a cap on concurrent sandboxes, because one container per thread is the
 *     expensive shape and an unbounded fan-out would exhaust the host.
 */
export interface QueuedTurn<T> {
  threadKey: string;
  run: () => Promise<T>;
}

export interface QueuePosition {
  /** 0 = running now; 1 = next; n = n ahead. */
  ahead: number;
}

export class TurnQueue {
  private readonly running = new Set<string>();
  private readonly pending: Array<{ threadKey: string; start: () => void }> = [];

  constructor(private readonly maxConcurrent = 4) {}

  /** How many turns are ahead of a hypothetical new turn for this thread. */
  positionFor(threadKey: string): QueuePosition {
    const threadBusy = this.running.has(threadKey) ? 1 : 0;
    const queuedForThread = this.pending.filter((p) => p.threadKey === threadKey).length;
    const globalWait = this.running.size >= this.maxConcurrent ? this.pending.length : 0;
    return { ahead: threadBusy + queuedForThread + (threadBusy ? 0 : globalWait) };
  }

  get activeCount(): number { return this.running.size; }

  /**
   * Thread keys with a turn in flight.
   *
   * The reaper needs this: it decides what to remove from `lastTurnAt`, which is only
   * stamped when a turn COMPLETES. A turn running longer than the idle threshold therefore
   * looks idle, and the reaper would `docker rm -f` the container out from under it.
   */
  get busyThreadKeys(): ReadonlySet<string> { return this.running; }
  get queuedCount(): number { return this.pending.length; }

  async submit<T>(turn: QueuedTurn<T>): Promise<T> {
    await this.acquire(turn.threadKey);
    try {
      return await turn.run();
    } finally {
      this.release(turn.threadKey);
    }
  }

  private acquire(threadKey: string): Promise<void> {
    const free = !this.running.has(threadKey) && this.running.size < this.maxConcurrent;
    if (free) {
      this.running.add(threadKey);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.pending.push({
        threadKey,
        start: () => { this.running.add(threadKey); resolve(); },
      });
    });
  }

  private release(threadKey: string): void {
    this.running.delete(threadKey);
    // Pick the first waiter that is now eligible: its thread is idle and we are under the cap.
    const index = this.pending.findIndex((p) => !this.running.has(p.threadKey));
    if (index === -1 || this.running.size >= this.maxConcurrent) return;
    const [next] = this.pending.splice(index, 1);
    next.start();
  }
}
