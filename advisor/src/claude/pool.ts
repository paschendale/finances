/**
 * Concurrency for Claude sessions (docs/ADVISOR.md §6.1): interactive turns share
 * MAX_CONCURRENT_SESSIONS slots and are never queued behind background work; background work
 * has one slot and yields (waits) whenever an interactive turn is waiting for a slot.
 */
export class SessionPool {
  private interactiveActive = 0;
  private interactiveWaiting = 0;
  private backgroundActive = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly maxInteractive: number) {}

  get stats() {
    return {
      interactiveActive: this.interactiveActive,
      interactiveWaiting: this.interactiveWaiting,
      backgroundActive: this.backgroundActive,
    };
  }

  async acquire(kind: 'interactive' | 'background'): Promise<() => void> {
    if (kind === 'interactive') this.interactiveWaiting++;
    try {
      while (!this.canStart(kind)) await new Promise<void>((r) => this.waiters.push(r));
    } finally {
      if (kind === 'interactive') this.interactiveWaiting--;
    }
    if (kind === 'interactive') this.interactiveActive++;
    else this.backgroundActive++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === 'interactive') this.interactiveActive--;
      else this.backgroundActive--;
      this.wake();
    };
  }

  private canStart(kind: 'interactive' | 'background'): boolean {
    if (kind === 'interactive') return this.interactiveActive < this.maxInteractive;
    // Background never starts while a person is waiting, and never overlaps itself.
    return this.backgroundActive === 0 && this.interactiveWaiting === 0 && this.interactiveActive < this.maxInteractive;
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

/** Serialises turns per conversation: a second message waits for the first turn to end. */
export class ConversationLocks {
  private chains = new Map<string, Promise<void>>();

  async run<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.chains.set(conversationId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(conversationId) === tail) this.chains.delete(conversationId);
    }
  }

  isBusy(conversationId: string): boolean {
    return this.chains.has(conversationId);
  }
}
