// Agent pool manager for Antfarm
// Limits the number of concurrently running Claude processes per board.
// Spawner calls are queued FIFO when the pool is at capacity and drained
// as slots free up.

type PoolStatusListener = (boardId: number, status: PoolStatus) => void;

export interface PoolStatus {
  active: number;
  queued: number;
  max: number;
}

interface QueueEntry {
  cardId: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface BoardPool {
  active: Set<number>;
  queue: QueueEntry[];
}

const SAFETY_TIMEOUT_MS = 35 * 60 * 1000; // 35 minutes

class AgentPool {
  private pools: Map<number, BoardPool> = new Map();
  private limits: Map<number, number> = new Map();
  private safetyTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();
  private onStatusChange: PoolStatusListener | null = null;

  // Register a callback fired on every pool state change (for SSE broadcast)
  setStatusListener(listener: PoolStatusListener): void {
    this.onStatusChange = listener;
  }

  // Ensure a board pool exists and return it
  private getOrCreatePool(boardId: number): BoardPool {
    let pool = this.pools.get(boardId);
    if (!pool) {
      pool = { active: new Set(), queue: [] };
      this.pools.set(boardId, pool);
    }
    return pool;
  }

  private getLimit(boardId: number): number {
    return this.limits.get(boardId) ?? 3;
  }

  private notify(boardId: number): void {
    if (this.onStatusChange) {
      this.onStatusChange(boardId, this.getStatus(boardId));
    }
  }

  // Set the concurrency limit for a board and drain queued entries if capacity increased
  setLimit(boardId: number, max: number): void {
    const clamped = Math.max(1, Math.min(20, max));
    const oldLimit = this.getLimit(boardId);
    this.limits.set(boardId, clamped);

    const pool = this.getOrCreatePool(boardId);

    if (clamped > oldLimit) {
      // Drain queued entries up to new available slots
      while (pool.queue.length > 0 && pool.active.size < clamped) {
        const entry = pool.queue.shift()!;
        pool.active.add(entry.cardId);
        this.startSafetyTimer(boardId, entry.cardId);
        entry.resolve();
      }
    }

    if (pool.active.size > clamped) {
      console.warn(
        `[antfarm] Pool for board ${boardId}: active (${pool.active.size}) exceeds new limit (${clamped}). ` +
        `No new slots will open until active count drops below ${clamped}.`
      );
    }

    this.notify(boardId);
  }

  // Acquire a pool slot. Resolves immediately if capacity available,
  // otherwise queues and resolves when a slot opens (FIFO).
  acquire(boardId: number, cardId: number): Promise<void> {
    const pool = this.getOrCreatePool(boardId);
    const limit = this.getLimit(boardId);

    // Guard against duplicate acquire for same card
    if (pool.active.has(cardId)) {
      return Promise.resolve();
    }

    // Also check if already queued
    if (pool.queue.some(e => e.cardId === cardId)) {
      return Promise.resolve();
    }

    if (pool.active.size < limit) {
      pool.active.add(cardId);
      this.startSafetyTimer(boardId, cardId);
      this.notify(boardId);
      return Promise.resolve();
    }

    // At capacity — queue this request
    return new Promise<void>((resolve, reject) => {
      pool.queue.push({ cardId, resolve, reject });
      this.notify(boardId);
    });
  }

  // Release a pool slot and drain the next queued entry if any
  release(boardId: number, cardId: number): void {
    const pool = this.pools.get(boardId);
    if (!pool) return;

    this.clearSafetyTimer(cardId);

    const wasActive = pool.active.delete(cardId);
    if (!wasActive) return;

    const limit = this.getLimit(boardId);

    // Drain queued entries up to available capacity
    while (pool.queue.length > 0 && pool.active.size < limit) {
      const next = pool.queue.shift()!;
      pool.active.add(next.cardId);
      this.startSafetyTimer(boardId, next.cardId);
      next.resolve();
    }

    this.notify(boardId);
  }

  // Remove a queued entry for a card (e.g. on archive or reset).
  // Returns true if the card was found and removed from the queue.
  cancelQueued(cardId: number): boolean {
    for (const [, pool] of this.pools) {
      const idx = pool.queue.findIndex(e => e.cardId === cardId);
      if (idx !== -1) {
        const [entry] = pool.queue.splice(idx, 1);
        entry.reject(new Error('Cancelled: card removed from queue'));
        // Find boardId for notification
        for (const [boardId, p] of this.pools) {
          if (p === pool) {
            this.notify(boardId);
            break;
          }
        }
        return true;
      }
    }
    return false;
  }

  // Get current pool status for a board
  getStatus(boardId: number): PoolStatus {
    const pool = this.pools.get(boardId);
    return {
      active: pool?.active.size ?? 0,
      queued: pool?.queue.length ?? 0,
      max: this.getLimit(boardId),
    };
  }

  // Clean up a board's pool entirely (e.g. on board deletion)
  destroyPool(boardId: number): void {
    const pool = this.pools.get(boardId);
    if (!pool) return;

    // Reject all queued entries
    for (const entry of pool.queue) {
      entry.reject(new Error('Pool destroyed: board deleted'));
    }
    pool.queue.length = 0;

    // Clear safety timers for active entries
    for (const cardId of pool.active) {
      this.clearSafetyTimer(cardId);
    }
    pool.active.clear();

    this.pools.delete(boardId);
    this.limits.delete(boardId);
  }

  // Safety timeout: auto-release slot if process never fires close/error
  private startSafetyTimer(boardId: number, cardId: number): void {
    this.clearSafetyTimer(cardId);
    this.safetyTimers.set(cardId, setTimeout(() => {
      console.warn(`[antfarm] Safety timeout: releasing pool slot for card ${cardId} on board ${boardId} after ${SAFETY_TIMEOUT_MS / 60000}min`);
      this.release(boardId, cardId);
    }, SAFETY_TIMEOUT_MS));
  }

  private clearSafetyTimer(cardId: number): void {
    const timer = this.safetyTimers.get(cardId);
    if (timer) {
      clearTimeout(timer);
      this.safetyTimers.delete(cardId);
    }
  }

  // Check if a card is currently active in any pool
  isActive(cardId: number): boolean {
    for (const [, pool] of this.pools) {
      if (pool.active.has(cardId)) return true;
    }
    return false;
  }

  // Check if a card is queued in any pool
  isQueued(cardId: number): boolean {
    for (const [, pool] of this.pools) {
      if (pool.queue.some(e => e.cardId === cardId)) return true;
    }
    return false;
  }
}

export const agentPool = new AgentPool();
