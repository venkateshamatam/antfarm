// Data access layer for Antfarm
// All database operations go through this module. Every function takes a
// Database instance as its first parameter and uses parameterized queries.

import fs from 'fs';
import nodePath from 'path';
import type { DatabaseInstance } from './schema.js';
import type {
  Board,
  Column,
  Card,
  Chain,
  Subtask,
  Note,
  ActivityLog,
  ClaimResult,
  ToolResponse,
  AgentStatus,
  Actor,
  NoteSource,
  NoteType,
  ModelName,
  ImplementationPlan,
  PlanStatus,
} from '../types.js';
import { hasCycle, resolveCompletedDeps } from './deps.js';

// ---------------------------------------------------------------------------
// Retry wrapper for SQLITE_BUSY errors
// Retries up to 3 times with 50ms exponential backoff between attempts
// ---------------------------------------------------------------------------

function withRetry<T>(fn: () => T, maxRetries = 3, baseDelayMs = 50): T {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      lastError = err;
      const isBusy =
        err instanceof Error && (err.message.includes('SQLITE_BUSY') || err.message.includes('database is locked'));
      if (!isBusy || attempt === maxRetries - 1) {
        throw err;
      }
      // Synchronous sleep via Atomics for better-sqlite3's synchronous API
      const delay = baseDelayMs * Math.pow(2, attempt);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Helpers to normalise rows coming out of SQLite (booleans stored as 0/1)
// ---------------------------------------------------------------------------

// Converts SQLite integer booleans to JS booleans for card rows
function normalizeCard(row: Record<string, unknown>): Card {
  return {
    ...row,
    archived: Boolean(row.archived),
  } as Card;
}

// Converts SQLite integer booleans to JS booleans for subtask rows
function normalizeSubtask(row: Record<string, unknown>): Subtask {
  return {
    ...row,
    completed: Boolean(row.completed),
  } as Subtask;
}

// ---------------------------------------------------------------------------
// Board operations
// ---------------------------------------------------------------------------

// Retrieves all boards ordered by creation date ascending
export function getBoards(db: DatabaseInstance): Board[] {
  return withRetry(() =>
    db.prepare('SELECT * FROM boards ORDER BY created_at ASC').all() as Board[]
  );
}

// Retrieves a single board by ID
export function getBoard(db: DatabaseInstance, boardId: number): Board | undefined {
  return withRetry(() =>
    db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId) as Board | undefined
  );
}

// Retrieves a board along with its columns, returns undefined if board not found
export function getBoardWithColumns(
  db: DatabaseInstance,
  boardId: number
): { board: Board; columns: Column[] } | undefined {
  return withRetry(() => {
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId) as Board | undefined;
    if (!board) return undefined;

    const columns = db
      .prepare('SELECT * FROM columns WHERE board_id = ? ORDER BY position ASC')
      .all(boardId) as Column[];

    return { board, columns };
  });
}

// ---------------------------------------------------------------------------
// Column operations
// ---------------------------------------------------------------------------

// Retrieves all columns for a board ordered by position
export function getColumns(db: DatabaseInstance, boardId: number): Column[] {
  return withRetry(() =>
    db.prepare('SELECT * FROM columns WHERE board_id = ? ORDER BY position ASC').all(boardId) as Column[]
  );
}

// ---------------------------------------------------------------------------
// Card operations
// ---------------------------------------------------------------------------

// Retrieves non-archived cards in a column ordered by position
export function getCards(db: DatabaseInstance, columnId: number): Card[] {
  return withRetry(() => {
    const rows = db
      .prepare('SELECT * FROM cards WHERE column_id = ? AND archived = 0 ORDER BY position ASC')
      .all(columnId) as Record<string, unknown>[];
    return rows.map(normalizeCard);
  });
}

// Retrieves a single card by ID
export function getCard(db: DatabaseInstance, cardId: number): Card | undefined {
  return withRetry(() => {
    const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
    return row ? normalizeCard(row) : undefined;
  });
}

// Finds a card by directory path. First tries exact match, then walks parent
// directories to find the closest matching card.
export function getCardByDirectory(db: DatabaseInstance, directoryPath: string): Card | undefined {
  return withRetry(() => {
    // Try exact match first
    const exact = db
      .prepare('SELECT * FROM cards WHERE directory_path = ? AND archived = 0')
      .get(directoryPath) as Record<string, unknown> | undefined;
    if (exact) return normalizeCard(exact);

    // Walk parent directories to find the closest ancestor match
    let current = directoryPath;
    while (true) {
      const parent = current.replace(/\/[^/]+$/, '');
      if (parent === current || parent === '') break;
      current = parent;

      const match = db
        .prepare('SELECT * FROM cards WHERE directory_path = ? AND archived = 0')
        .get(current) as Record<string, unknown> | undefined;
      if (match) return normalizeCard(match);
    }

    return undefined;
  });
}

// Retrieves all non-archived cards across all columns in a board, including
// column name and position for display purposes
export function getAllBoardCards(db: DatabaseInstance, boardId: number): Card[] {
  return withRetry(() => {
    const rows = db
      .prepare(
        `SELECT c.*, col.name as column_name, col.position as column_position
         FROM cards c
         JOIN columns col ON col.id = c.column_id
         WHERE col.board_id = ? AND c.archived = 0
         ORDER BY col.position ASC, c.position ASC`
      )
      .all(boardId) as Record<string, unknown>[];
    return rows.map(normalizeCard);
  });
}

// Creates a new card with optional dependencies. Inserts the card, adds
// dependency edges if depends_on is provided, and logs the creation activity.
export function createCard(
  db: DatabaseInstance,
  data: {
    column_id: number;
    title: string;
    description?: string;
    context?: string;
    files?: string[];
    directory_path?: string;
    depends_on?: number[];
    model?: string;
  }
): Card {
  return withRetry(() => {
    const result = db.transaction(() => {
      // Determine the next position in the column
      const maxPos = db
        .prepare('SELECT COALESCE(MAX(position), -1) as max_pos FROM cards WHERE column_id = ?')
        .get(data.column_id) as { max_pos: number };

      const filesJson = data.files ? JSON.stringify(data.files) : null;

      const insertResult = db
        .prepare(
          `INSERT INTO cards (column_id, title, description, context, files, directory_path, position, model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          data.column_id,
          data.title,
          data.description ?? null,
          data.context ?? null,
          filesJson,
          data.directory_path ?? null,
          maxPos.max_pos + 1,
          data.model ?? null
        );

      const cardId = Number(insertResult.lastInsertRowid);

      // Insert dependency edges if any depends_on IDs were provided
      if (data.depends_on && data.depends_on.length > 0) {
        const insertDep = db.prepare(
          'INSERT OR IGNORE INTO card_deps (card_id, depends_on_card_id) VALUES (?, ?)'
        );
        for (const depId of data.depends_on) {
          insertDep.run(cardId, depId);
        }
      }

      // Log the card creation activity
      db.prepare(
        `INSERT INTO activity_log (card_id, action, actor, details_json)
         VALUES (?, 'card.created', 'user', ?)`
      ).run(cardId, JSON.stringify({ title: data.title }));

      // Return the newly created card
      const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown>;
      return normalizeCard(card);
    })();

    return result;
  });
}

// Updates specific fields on a card and refreshes updated_at
export function updateCard(
  db: DatabaseInstance,
  cardId: number,
  data: Partial<Pick<Card, 'title' | 'description' | 'context' | 'files' | 'column_id' | 'position' | 'directory_path' | 'spec' | 'agent_status' | 'spec_status' | 'model'>>
): Card | undefined {
  return withRetry(() => {
    // Build SET clauses dynamically from the provided fields
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (data.title !== undefined) {
      setClauses.push('title = ?');
      values.push(data.title);
    }
    if (data.description !== undefined) {
      setClauses.push('description = ?');
      values.push(data.description);
    }
    if (data.context !== undefined) {
      setClauses.push('context = ?');
      values.push(data.context);
    }
    if (data.files !== undefined) {
      setClauses.push('files = ?');
      values.push(data.files);
    }
    if (data.column_id !== undefined) {
      setClauses.push('column_id = ?');
      values.push(data.column_id);
      // When moving to a new column, auto-assign next position unless explicitly provided
      if (data.position === undefined) {
        const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) as max_pos FROM cards WHERE column_id = ? AND archived = 0').get(data.column_id) as { max_pos: number };
        setClauses.push('position = ?');
        values.push(maxPos.max_pos + 1);
      }
    }
    if (data.position !== undefined) {
      setClauses.push('position = ?');
      values.push(data.position);
    }
    if (data.directory_path !== undefined) {
      setClauses.push('directory_path = ?');
      values.push(data.directory_path);
    }
    if (data.spec !== undefined) {
      setClauses.push('spec = ?');
      values.push(data.spec);
    }
    if (data.agent_status !== undefined) {
      setClauses.push('agent_status = ?');
      values.push(data.agent_status);
    }
    if (data.spec_status !== undefined) {
      setClauses.push('spec_status = ?');
      values.push(data.spec_status);
    }
    if (data.model !== undefined) {
      setClauses.push('model = ?');
      values.push(data.model);
    }

    if (setClauses.length === 0) {
      return getCard(db, cardId);
    }

    setClauses.push("updated_at = datetime('now')");
    values.push(cardId);

    db.prepare(`UPDATE cards SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
    return row ? normalizeCard(row) : undefined;
  });
}

// Archives a card, resolves its dependencies for any dependents, and returns
// the list of card IDs that became unblocked. Rejects if the card's agent is
// currently working.
export function archiveCard(
  db: DatabaseInstance,
  cardId: number
): { success: boolean; unblocked: number[] } {
  return withRetry(() => {
    return db.transaction(() => {
      const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
      if (!card) {
        return { success: false, unblocked: [] };
      }

      // Reject archiving if the agent is actively working on this card
      if (card.agent_status === 'working') {
        return { success: false, unblocked: [] };
      }

      // Set archived flag and update timestamp
      db.prepare("UPDATE cards SET archived = 1, updated_at = datetime('now') WHERE id = ?").run(cardId);

      // Resolve dependency edges that pointed at this card
      const unblocked = resolveCompletedDeps(db, cardId);

      // Log the archive activity
      db.prepare(
        `INSERT INTO activity_log (card_id, action, actor, details_json)
         VALUES (?, 'card.archived', 'user', NULL)`
      ).run(cardId);

      return { success: true, unblocked };
    })();
  });
}

// ---------------------------------------------------------------------------
// Agent coordination operations
// ---------------------------------------------------------------------------

// Attempts to claim a card for an agent session using BEGIN IMMEDIATE
// to serialise concurrent claims. Checks the card exists, is not archived,
// is not already claimed, and has no unresolved blockers before claiming.
export function claimCard(
  db: DatabaseInstance,
  cardId: number,
  sessionId: string
): ClaimResult {
  return withRetry(() => {
    return db.transaction(() => {
      const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;

      if (!row) {
        return { claimed: false, reason: 'not_found' as const };
      }

      const card = normalizeCard(row);

      if (card.archived) {
        return { claimed: false, reason: 'not_found' as const };
      }

      if (card.assigned_session !== null) {
        return { claimed: false, reason: 'already_claimed' as const };
      }

      // Check for unresolved blockers
      const blockerCount = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM card_deps cd
           JOIN cards c ON c.id = cd.depends_on_card_id
           WHERE cd.card_id = ? AND c.agent_status != 'completed' AND c.archived = 0`
        )
        .get(cardId) as { cnt: number };

      if (blockerCount.cnt > 0) {
        return { claimed: false, reason: 'has_blockers' as const };
      }

      // Claim the card: set session, mark as working, record activity timestamp
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE cards
         SET assigned_session = ?, agent_status = 'working', last_activity_at = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(sessionId, now, cardId);

      // Log the claim activity
      db.prepare(
        `INSERT INTO activity_log (card_id, action, actor, details_json)
         VALUES (?, 'card.claimed', 'agent', ?)`
      ).run(cardId, JSON.stringify({ session_id: sessionId }));

      // Return the updated card
      const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown>;
      return { claimed: true, card: normalizeCard(updated) };
    })();
  });
}

// Completes a card: verifies it is in working state and assigned to the given
// session, moves it to the Done column, resolves dependencies for downstream
// cards, and logs the activity.
export function completeCard(
  db: DatabaseInstance,
  cardId: number,
  sessionId: string
): { success: boolean; unblocked: number[] } {
  return withRetry(() => {
    return db.transaction(() => {
      const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
      if (!row) return { success: false, unblocked: [] };

      const card = normalizeCard(row);

      // Only the session that claimed the card while it is working can complete it
      if (card.agent_status !== 'working' || card.assigned_session !== sessionId) {
        return { success: false, unblocked: [] };
      }

      // Find the Done column (highest position) in the same board
      const doneColumn = db
        .prepare(
          `SELECT col.id FROM columns col
           WHERE col.board_id = (SELECT board_id FROM columns WHERE id = ?)
           ORDER BY col.position DESC LIMIT 1`
        )
        .get(card.column_id) as { id: number } | undefined;

      const doneColumnId = doneColumn ? doneColumn.id : card.column_id;

      // Mark card as completed and move to Done column
      db.prepare(
        `UPDATE cards
         SET agent_status = 'completed', column_id = ?, updated_at = datetime('now')
         WHERE id = ?`
      ).run(doneColumnId, cardId);

      // Resolve dependencies that were waiting on this card
      const unblocked = resolveCompletedDeps(db, cardId);

      // Log the completion activity
      db.prepare(
        `INSERT INTO activity_log (card_id, action, actor, details_json)
         VALUES (?, 'card.completed', 'agent', ?)`
      ).run(cardId, JSON.stringify({ session_id: sessionId, unblocked }));

      return { success: true, unblocked };
    })();
  });
}

// Signals that a card is blocked by another card. Validates no cycle would be
// created, inserts the dependency edge, moves the card to the Blocked column,
// and sets its agent status to waiting.
export function signalBlocked(
  db: DatabaseInstance,
  cardId: number,
  blockedByCardId: number
): ToolResponse {
  return withRetry<ToolResponse>(() => {
    return db.transaction(() => {
      // Verify both cards exist
      const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
      const blocker = db.prepare('SELECT * FROM cards WHERE id = ?').get(blockedByCardId) as Record<string, unknown> | undefined;

      if (!card) {
        return { success: false as const, error: `Card ${cardId} not found` } satisfies ToolResponse;
      }
      if (!blocker) {
        return { success: false as const, error: `Blocker card ${blockedByCardId} not found` } satisfies ToolResponse;
      }

      // Check for cycles before adding the dependency edge
      if (hasCycle(db, cardId, blockedByCardId)) {
        return { success: false as const, error: 'Adding this dependency would create a cycle' } satisfies ToolResponse;
      }

      // Insert the dependency edge
      db.prepare(
        'INSERT OR IGNORE INTO card_deps (card_id, depends_on_card_id) VALUES (?, ?)'
      ).run(cardId, blockedByCardId);

      // Mark card as waiting (keep it in its current column)
      db.prepare(
        "UPDATE cards SET agent_status = 'waiting', updated_at = datetime('now') WHERE id = ?"
      ).run(cardId);

      // Log the blocked activity
      db.prepare(
        `INSERT INTO activity_log (card_id, action, actor, details_json)
         VALUES (?, 'card.blocked', 'agent', ?)`
      ).run(cardId, JSON.stringify({ blocked_by_card_id: blockedByCardId }));

      return { success: true as const, data: { card_id: cardId, blocked_by: blockedByCardId } } satisfies ToolResponse;
    })();
  });
}

// Finds the highest-priority unblocked idle card from Spec Ready (first) or Idea
// columns, atomically claims it for the given agent, and returns it. Returns
// { found: false } if no eligible card exists. Uses a transaction to prevent double-claiming.
export function getNextAvailableCard(
  db: DatabaseInstance,
  agentId: string,
  boardId: number
): { found: true; card: Card & { original_column: string; dependencies: number[]; claimed_at: string } } | { found: false; reason: string } {
  return withRetry(() => {
    return db.transaction(() => {
      // Get candidate cards: approved first, then idea, ordered by position
      // within each column. NULL positions sort last.
      const candidates = db
        .prepare(
          `SELECT c.*, col.name as column_name
           FROM cards c
           JOIN columns col ON col.id = c.column_id
           WHERE col.board_id = ?
             AND col.name IN ('Spec Ready', 'Idea')
             AND c.agent_status = 'idle'
             AND c.assigned_session IS NULL
             AND c.archived = 0
           ORDER BY
             CASE col.name WHEN 'Spec Ready' THEN 0 WHEN 'Idea' THEN 1 END ASC,
             CASE WHEN c.position IS NULL THEN 1 ELSE 0 END ASC,
             c.position ASC,
             c.created_at ASC`
        )
        .all(boardId) as (Record<string, unknown> & { column_name: string })[];

      if (candidates.length === 0) {
        return { found: false as const, reason: 'no_eligible_cards' };
      }

      // Check each candidate for unresolved dependencies
      const getBlockerCount = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM card_deps cd
        JOIN cards blocker ON blocker.id = cd.depends_on_card_id
        WHERE cd.card_id = ?
          AND blocker.agent_status != 'completed'
          AND blocker.archived = 0
      `);

      // Also detect circular deps: a card is in a cycle if it transitively
      // depends on itself. We check by seeing if any blocker is itself blocked
      // by the candidate (simple cycle detection for the immediate selection).
      // For full cycle detection, we check if any dependency chain loops.
      const getDeps = db.prepare(
        'SELECT depends_on_card_id FROM card_deps WHERE card_id = ?'
      );

      for (const candidate of candidates) {
        const cardId = candidate.id as number;

        // Check for unresolved blockers
        const blockerResult = getBlockerCount.get(cardId) as { cnt: number };
        if (blockerResult.cnt > 0) {
          // Check if this is a circular dependency (card can never be unblocked)
          const deps = getDeps.all(cardId) as { depends_on_card_id: number }[];
          if (deps.length > 0) {
            // Check if any dep chain leads back to this card (cycle)
            const visited = new Set<number>();
            const stack = deps.map(d => d.depends_on_card_id);
            let isCycle = false;
            while (stack.length > 0) {
              const current = stack.pop()!;
              if (current === cardId) { isCycle = true; break; }
              if (visited.has(current)) continue;
              visited.add(current);
              const nextDeps = getDeps.all(current) as { depends_on_card_id: number }[];
              for (const nd of nextDeps) {
                if (!visited.has(nd.depends_on_card_id)) stack.push(nd.depends_on_card_id);
              }
            }
            if (isCycle) {
              // Log warning and skip — this card has circular dependencies
              db.prepare(
                "INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, 'card.circular_dep_warning', 'agent', ?)"
              ).run(cardId, JSON.stringify({ message: 'Skipped due to circular dependency' }));
            }
          }
          continue;
        }

        // This card is eligible — claim it atomically
        const claimedAt = new Date().toISOString();
        const originalColumn = candidate.column_name;

        // Find the Building column to move the card there
        const buildingCol = db.prepare(
          "SELECT id FROM columns WHERE board_id = (SELECT board_id FROM columns WHERE id = ?) AND name = 'Building' LIMIT 1"
        ).get(candidate.column_id as number) as { id: number } | undefined;

        const targetColumnId = buildingCol ? buildingCol.id : candidate.column_id as number;

        // Atomically claim: update status, assign agent, move to Building
        const result = db.prepare(
          `UPDATE cards
           SET agent_status = 'working',
               assigned_session = ?,
               last_activity_at = ?,
               column_id = ?,
               updated_at = datetime('now')
           WHERE id = ? AND agent_status = 'idle' AND assigned_session IS NULL`
        ).run(agentId, claimedAt, targetColumnId, cardId);

        // If zero rows affected, another agent claimed it — try next candidate
        if (result.changes === 0) {
          continue;
        }

        // Log the claim
        db.prepare(
          "INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, 'card.auto_claimed', 'agent', ?)"
        ).run(cardId, JSON.stringify({ agent_id: agentId, original_column: originalColumn }));

        // Get resolved dependency IDs
        const resolvedDeps = db.prepare(
          `SELECT depends_on_card_id FROM card_deps WHERE card_id = ?`
        ).all(cardId) as { depends_on_card_id: number }[];

        // Re-read the updated card
        const updatedRow = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown>;
        const updatedCard = normalizeCard(updatedRow);

        return {
          found: true as const,
          card: {
            ...updatedCard,
            original_column: originalColumn,
            dependencies: resolvedDeps.map(d => d.depends_on_card_id),
            claimed_at: claimedAt,
          },
        };
      }

      return { found: false as const, reason: 'no_eligible_cards' };
    })();
  });
}

// Returns cards whose dependencies are all completed or archived and that
// have no assigned session, making them eligible for an agent to pick up.
export function getUnblockedCards(db: DatabaseInstance, boardId: number): Card[] {
  return withRetry(() => {
    const rows = db
      .prepare(
        `SELECT c.* FROM cards c
         JOIN columns col ON col.id = c.column_id
         WHERE col.board_id = ?
           AND c.assigned_session IS NULL
           AND c.archived = 0
           AND NOT EXISTS (
             SELECT 1 FROM card_deps cd
             JOIN cards blocker ON blocker.id = cd.depends_on_card_id
             WHERE cd.card_id = c.id
               AND blocker.agent_status != 'completed'
               AND blocker.archived = 0
           )
         ORDER BY c.position ASC, c.created_at ASC`
      )
      .all(boardId) as Record<string, unknown>[];

    return rows.map(normalizeCard);
  });
}

// Updates the agent_status and last_activity_at for a card, verifying the
// session matches the assigned session
export function updateStatus(
  db: DatabaseInstance,
  cardId: number,
  sessionId: string,
  status: AgentStatus
): Card | undefined {
  return withRetry(() => {
    const now = new Date().toISOString();
    const result = db
      .prepare(
        `UPDATE cards
         SET agent_status = ?, last_activity_at = ?, updated_at = datetime('now')
         WHERE id = ? AND assigned_session = ?`
      )
      .run(status, now, cardId, sessionId);

    if (result.changes === 0) return undefined;

    const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
    return row ? normalizeCard(row) : undefined;
  });
}

// Finds cards with agent_status='working' whose last_activity_at is older
// than the specified number of minutes. Resets them by clearing the session
// and setting status to idle so they can be reclaimed.
export function releaseStaleCards(db: DatabaseInstance, minutesStale: number): Card[] {
  return withRetry(() => {
    return db.transaction(() => {
      // Find stale working cards (includes cards with NULL last_activity_at
      // that have been working longer than the threshold based on updated_at)
      const staleRows = db
        .prepare(
          `SELECT * FROM cards
           WHERE agent_status = 'working'
             AND archived = 0
             AND (
               (last_activity_at IS NOT NULL AND last_activity_at < datetime('now', ? || ' minutes'))
               OR (last_activity_at IS NULL AND updated_at < datetime('now', ? || ' minutes'))
             )`
        )
        .all(`-${minutesStale}`, `-${minutesStale}`) as Record<string, unknown>[];

      if (staleRows.length === 0) return [];

      const released: Card[] = [];

      const resetStmt = db.prepare(
        `UPDATE cards
         SET assigned_session = NULL, agent_status = 'errored', updated_at = datetime('now')
         WHERE id = ?`
      );

      const logStmt = db.prepare(
        `INSERT INTO activity_log (card_id, action, actor, details_json)
         VALUES (?, 'card.released', 'agent', ?)`
      );

      for (const row of staleRows) {
        const cardId = row.id as number;
        resetStmt.run(cardId);

        logStmt.run(
          cardId,
          JSON.stringify({
            previous_session: row.assigned_session,
            stale_minutes: minutesStale,
          })
        );

        // Re-read the card after reset
        const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown>;
        released.push(normalizeCard(updated));
      }

      return released;
    })();
  });
}

// Updates last_activity_at to now for a card, acting as a heartbeat to
// prevent the card from being released as stale
export function touchCard(db: DatabaseInstance, cardId: number, sessionId: string): void {
  withRetry(() => {
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE cards SET last_activity_at = ? WHERE id = ? AND assigned_session = ?'
    ).run(now, cardId, sessionId);
  });
}

// ---------------------------------------------------------------------------
// Subtask operations
// ---------------------------------------------------------------------------

// Retrieves all subtasks for a card ordered by position
export function getSubtasks(db: DatabaseInstance, cardId: number): Subtask[] {
  return withRetry(() => {
    const rows = db
      .prepare('SELECT * FROM subtasks WHERE card_id = ? ORDER BY position ASC')
      .all(cardId) as Record<string, unknown>[];
    return rows.map(normalizeSubtask);
  });
}

// Adds a new subtask to a card at the next available position
export function addSubtask(db: DatabaseInstance, cardId: number, text: string): Subtask {
  return withRetry(() => {
    const maxPos = db
      .prepare('SELECT COALESCE(MAX(position), -1) as max_pos FROM subtasks WHERE card_id = ?')
      .get(cardId) as { max_pos: number };

    const result = db
      .prepare('INSERT INTO subtasks (card_id, text, position) VALUES (?, ?, ?)')
      .run(cardId, text, maxPos.max_pos + 1);

    const row = db
      .prepare('SELECT * FROM subtasks WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as Record<string, unknown>;

    return normalizeSubtask(row);
  });
}

// Marks a subtask as completed
export function completeSubtask(db: DatabaseInstance, subtaskId: number): Subtask | undefined {
  return withRetry(() => {
    const result = db
      .prepare('UPDATE subtasks SET completed = 1 WHERE id = ?')
      .run(subtaskId);

    if (result.changes === 0) return undefined;

    const row = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(subtaskId) as Record<string, unknown> | undefined;
    return row ? normalizeSubtask(row) : undefined;
  });
}

// Toggles a subtask's completed state
export function toggleSubtask(db: DatabaseInstance, subtaskId: number): Subtask | undefined {
  return withRetry(() => {
    const result = db
      .prepare('UPDATE subtasks SET completed = CASE WHEN completed = 1 THEN 0 ELSE 1 END WHERE id = ?')
      .run(subtaskId);

    if (result.changes === 0) return undefined;

    const row = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(subtaskId) as Record<string, unknown> | undefined;
    return row ? normalizeSubtask(row) : undefined;
  });
}

// ---------------------------------------------------------------------------
// Note operations
// ---------------------------------------------------------------------------

// Retrieves all notes for a card ordered by creation date ascending
export function getNotes(db: DatabaseInstance, cardId: number): Note[] {
  return withRetry(() =>
    db.prepare('SELECT * FROM notes WHERE card_id = ? ORDER BY created_at ASC').all(cardId) as Note[]
  );
}

// Adds a note to a card with the given source (user/agent) and type
export function addNote(
  db: DatabaseInstance,
  cardId: number,
  content: string,
  source: NoteSource,
  type: NoteType
): Note {
  return withRetry(() => {
    const result = db
      .prepare('INSERT INTO notes (card_id, content, source, type) VALUES (?, ?, ?, ?)')
      .run(cardId, content, source, type);

    return db
      .prepare('SELECT * FROM notes WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as Note;
  });
}

// ---------------------------------------------------------------------------
// Activity operations
// ---------------------------------------------------------------------------

// Retrieves activity log entries, optionally filtered by card ID, ordered by
// creation date descending. Defaults to 50 entries.
export function getActivity(
  db: DatabaseInstance,
  options?: { cardId?: number; limit?: number }
): ActivityLog[] {
  return withRetry(() => {
    const limit = options?.limit ?? 50;

    if (options?.cardId !== undefined) {
      return db
        .prepare('SELECT * FROM activity_log WHERE card_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(options.cardId, limit) as ActivityLog[];
    }

    return db
      .prepare('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?')
      .all(limit) as ActivityLog[];
  });
}

// Logs an activity event to the activity_log table
export function logActivity(
  db: DatabaseInstance,
  action: string,
  actor: Actor,
  cardId?: number,
  details?: string
): ActivityLog {
  return withRetry(() => {
    const result = db
      .prepare(
        'INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, ?, ?, ?)'
      )
      .run(cardId ?? null, action, actor, details ?? null);

    return db
      .prepare('SELECT * FROM activity_log WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as ActivityLog;
  });
}

// ---------------------------------------------------------------------------
// Pipeline-specific operations (spec generation, PR tracking)
// ---------------------------------------------------------------------------

// Updates the spec content on a card and sets spec_status to 'ready'
export function updateSpec(db: DatabaseInstance, cardId: number, spec: string): Card | undefined {
  return withRetry(() => {
    db.prepare(
      "UPDATE cards SET spec = ?, spec_status = 'ready', updated_at = datetime('now') WHERE id = ?"
    ).run(spec, cardId);

    // Move to Spec Ready column
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
    if (card) {
      const specReadyCol = db.prepare(
        "SELECT id FROM columns WHERE board_id = (SELECT board_id FROM columns WHERE id = ?) AND name = 'Spec Ready' LIMIT 1"
      ).get(card.column_id) as { id: number } | undefined;
      if (specReadyCol) {
        db.prepare(
          "UPDATE cards SET column_id = ?, agent_status = 'idle', updated_at = datetime('now') WHERE id = ?"
        ).run(specReadyCol.id, cardId);
      }
    }

    db.prepare(
      "INSERT INTO activity_log (card_id, action, actor) VALUES (?, 'card.spec_ready', 'agent')"
    ).run(cardId);

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
    return updated ? normalizeCard(updated) : undefined;
  });
}

// Attaches a PR URL and branch name to a card, moves it to Done column
export function setPr(db: DatabaseInstance, cardId: number, prUrl: string, branch: string): Card | undefined {
  return withRetry(() => {
    db.prepare(
      "UPDATE cards SET pr_url = ?, pr_branch = ?, agent_status = 'completed', updated_at = datetime('now') WHERE id = ?"
    ).run(prUrl, branch, cardId);

    // Move to Done column
    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
    if (card) {
      const doneCol = db.prepare(
        "SELECT id FROM columns WHERE board_id = (SELECT board_id FROM columns WHERE id = ?) AND name = 'Done' LIMIT 1"
      ).get(card.column_id) as { id: number } | undefined;
      if (doneCol) {
        db.prepare("UPDATE cards SET column_id = ?, updated_at = datetime('now') WHERE id = ?").run(doneCol.id, cardId);
      }
    }

    db.prepare(
      "INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, 'card.pr_ready', 'agent', ?)"
    ).run(cardId, JSON.stringify({ pr_url: prUrl, branch }));

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as Record<string, unknown> | undefined;
    return updated ? normalizeCard(updated) : undefined;
  });
}

// Reads all CLAUDE.md files from a board's project directory
export function getProjectContext(db: DatabaseInstance, boardId: number): { path: string; content: string }[] {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId) as Record<string, unknown> | undefined;
  if (!board?.directory) return [];

  const dir = board.directory as string;
  const results: { path: string; content: string }[] = [];

  function scan(d: string, depth: number) {
    if (depth > 3) return;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = nodePath.join(d, entry.name);
        if (entry.isFile() && entry.name.toUpperCase() === 'CLAUDE.MD') {
          results.push({ path: full, content: fs.readFileSync(full, 'utf-8') });
        } else if (entry.isDirectory()) {
          scan(full, depth + 1);
        }
      }
    } catch { /* permission errors */ }
  }

  scan(dir, 0);
  return results;
}

// ---------------------------------------------------------------------------
// Plan operations
// ---------------------------------------------------------------------------

// Parses a task_plans row from SQLite into an ImplementationPlan object
function normalizePlan(row: Record<string, unknown>): ImplementationPlan {
  return {
    id: row.id as number,
    card_id: row.card_id as number,
    version: row.version as number,
    files_to_create: JSON.parse((row.files_to_create as string) || '[]'),
    files_to_modify: JSON.parse((row.files_to_modify as string) || '[]'),
    steps: JSON.parse((row.steps as string) || '[]'),
    estimated_scope: row.estimated_scope as 'small' | 'medium' | 'large',
    dependencies: JSON.parse((row.dependencies as string) || '[]'),
    feedback: row.feedback as string | null,
    created_at: row.created_at as string,
  };
}

// Retrieves the latest plan for a card (highest version)
export function getLatestPlan(db: DatabaseInstance, cardId: number): ImplementationPlan | undefined {
  return withRetry(() => {
    const row = db.prepare(
      'SELECT * FROM task_plans WHERE card_id = ? ORDER BY version DESC LIMIT 1'
    ).get(cardId) as Record<string, unknown> | undefined;
    return row ? normalizePlan(row) : undefined;
  });
}

// Retrieves all plan versions for a card
export function getPlanVersions(db: DatabaseInstance, cardId: number): ImplementationPlan[] {
  return withRetry(() => {
    const rows = db.prepare(
      'SELECT * FROM task_plans WHERE card_id = ? ORDER BY version ASC'
    ).all(cardId) as Record<string, unknown>[];
    return rows.map(normalizePlan);
  });
}

// Creates a new plan version for a card, returns the created plan
export function createPlan(
  db: DatabaseInstance,
  cardId: number,
  plan: {
    files_to_create: Array<{ path: string; purpose: string }>;
    files_to_modify: Array<{ path: string; changes: string }>;
    steps: Array<{ order: number; description: string; files: string[] }>;
    estimated_scope: 'small' | 'medium' | 'large';
    dependencies: string[];
  }
): ImplementationPlan {
  return withRetry(() => {
    // Determine next version number
    const maxVersion = db.prepare(
      'SELECT COALESCE(MAX(version), 0) as max_ver FROM task_plans WHERE card_id = ?'
    ).get(cardId) as { max_ver: number };

    const version = maxVersion.max_ver + 1;

    const result = db.prepare(
      `INSERT INTO task_plans (card_id, version, files_to_create, files_to_modify, steps, estimated_scope, dependencies)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      cardId,
      version,
      JSON.stringify(plan.files_to_create),
      JSON.stringify(plan.files_to_modify),
      JSON.stringify(plan.steps),
      plan.estimated_scope,
      JSON.stringify(plan.dependencies),
    );

    const row = db.prepare('SELECT * FROM task_plans WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as Record<string, unknown>;
    return normalizePlan(row);
  });
}

// Updates plan_status on a card
export function updatePlanStatus(db: DatabaseInstance, cardId: number, status: PlanStatus): void {
  withRetry(() => {
    db.prepare(
      "UPDATE cards SET plan_status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, cardId);
  });
}

// Stores rejection feedback on the latest plan
export function rejectPlan(db: DatabaseInstance, cardId: number, feedback: string): void {
  withRetry(() => {
    db.prepare(
      `UPDATE task_plans SET feedback = ? WHERE card_id = ? AND version = (SELECT MAX(version) FROM task_plans WHERE card_id = ?)`
    ).run(feedback, cardId, cardId);
  });
}

// Returns the count of plan versions for a card (for re-plan cap)
export function getPlanCount(db: DatabaseInstance, cardId: number): number {
  return withRetry(() => {
    const row = db.prepare(
      'SELECT COUNT(*) as cnt FROM task_plans WHERE card_id = ?'
    ).get(cardId) as { cnt: number };
    return row.cnt;
  });
}

// ---------------------------------------------------------------------------
// chain operations
// ---------------------------------------------------------------------------

// creates a new chain for a board
export function createChain(db: DatabaseInstance, boardId: number, name: string): Chain {
  return withRetry(() => {
    const result = db.prepare('INSERT INTO chains (board_id, name) VALUES (?, ?)').run(boardId, name);
    return db.prepare('SELECT * FROM chains WHERE id = ?').get(Number(result.lastInsertRowid)) as Chain;
  });
}

// retrieves a chain by id with its ordered cards
export function getChain(db: DatabaseInstance, chainId: number): { chain: Chain; cards: Card[] } | undefined {
  return withRetry(() => {
    const chain = db.prepare('SELECT * FROM chains WHERE id = ?').get(chainId) as Chain | undefined;
    if (!chain) return undefined;
    const rows = db.prepare(
      'SELECT * FROM cards WHERE chain_id = ? AND archived = 0 ORDER BY chain_position ASC'
    ).all(chainId) as Record<string, unknown>[];
    return { chain, cards: rows.map(normalizeCard) };
  });
}

// lists all chains for a board
export function getChainsForBoard(db: DatabaseInstance, boardId: number): Chain[] {
  return withRetry(() =>
    db.prepare('SELECT * FROM chains WHERE board_id = ? ORDER BY created_at ASC').all(boardId) as Chain[]
  );
}

// updates a chain's name
export function updateChain(db: DatabaseInstance, chainId: number, name: string): Chain | undefined {
  return withRetry(() => {
    db.prepare('UPDATE chains SET name = ? WHERE id = ?').run(name, chainId);
    return db.prepare('SELECT * FROM chains WHERE id = ?').get(chainId) as Chain | undefined;
  });
}

// deletes a chain. clears chain_position on cards first, then ON DELETE SET NULL handles chain_id.
export function deleteChain(db: DatabaseInstance, chainId: number): boolean {
  return withRetry(() => {
    // Clear chain_position on cards that will lose their chain_id
    db.prepare('UPDATE cards SET chain_position = NULL WHERE chain_id = ?').run(chainId);
    const result = db.prepare('DELETE FROM chains WHERE id = ?').run(chainId);
    return result.changes > 0;
  });
}

// adds a card to a chain at a given position (or appends at end)
export function addCardToChain(db: DatabaseInstance, chainId: number, cardId: number, position?: number): void {
  withRetry(() => {
    db.transaction(() => {
      if (position != null) {
        // Shift existing cards at >= position up by 1
        db.prepare('UPDATE cards SET chain_position = chain_position + 1 WHERE chain_id = ? AND chain_position >= ?')
          .run(chainId, position);
        db.prepare('UPDATE cards SET chain_id = ?, chain_position = ? WHERE id = ?')
          .run(chainId, position, cardId);
      } else {
        // Append at end
        const max = db.prepare(
          'SELECT MAX(chain_position) as maxPos FROM cards WHERE chain_id = ?'
        ).get(chainId) as { maxPos: number | null };
        const nextPos = (max.maxPos ?? -1) + 1;
        db.prepare('UPDATE cards SET chain_id = ?, chain_position = ? WHERE id = ?')
          .run(chainId, nextPos, cardId);
      }
    })();
  });
}

// removes a card from its chain and compacts positions
export function removeCardFromChain(db: DatabaseInstance, cardId: number): void {
  withRetry(() => {
    db.transaction(() => {
      const card = db.prepare('SELECT chain_id, chain_position FROM cards WHERE id = ?').get(cardId) as
        { chain_id: number | null; chain_position: number | null } | undefined;
      if (!card?.chain_id) return;

      db.prepare('UPDATE cards SET chain_id = NULL, chain_position = NULL WHERE id = ?').run(cardId);
      // Compact: shift cards above the removed position down by 1
      if (card.chain_position != null) {
        db.prepare(
          'UPDATE cards SET chain_position = chain_position - 1 WHERE chain_id = ? AND chain_position > ?'
        ).run(card.chain_id, card.chain_position);
      }
    })();
  });
}

// reorders cards in a chain atomically. card_ids must all belong to the chain.
export function reorderChainCards(db: DatabaseInstance, chainId: number, cardIds: number[]): void {
  withRetry(() => {
    db.transaction(() => {
      // Validate all cards belong to this chain
      for (const id of cardIds) {
        const card = db.prepare('SELECT chain_id FROM cards WHERE id = ?').get(id) as { chain_id: number | null } | undefined;
        if (!card || card.chain_id !== chainId) {
          throw new Error(`Card ${id} does not belong to chain ${chainId}`);
        }
      }
      // Update positions based on array order (0-indexed, dense)
      const stmt = db.prepare('UPDATE cards SET chain_position = ? WHERE id = ? AND chain_id = ?');
      for (let i = 0; i < cardIds.length; i++) {
        stmt.run(i, cardIds[i], chainId);
      }
    })();
  });
}

// finds the next card in a chain after the given position.
// returns undefined if no more cards (chain complete).
export function getNextChainCard(db: DatabaseInstance, chainId: number, currentPosition: number): Card | undefined {
  return withRetry(() => {
    const row = db.prepare(
      `SELECT * FROM cards
       WHERE chain_id = ? AND chain_position > ? AND chain_id IS NOT NULL AND archived = 0
       ORDER BY chain_position ASC LIMIT 1`
    ).get(chainId, currentPosition) as Record<string, unknown> | undefined;
    return row ? normalizeCard(row) : undefined;
  });
}

// returns the previous card in a chain (for session handoff via --resume)
export function getPreviousChainCard(db: DatabaseInstance, chainId: number, currentPosition: number): Card | undefined {
  return withRetry(() => {
    const row = db.prepare(
      `SELECT * FROM cards
       WHERE chain_id = ? AND chain_position < ? AND chain_id IS NOT NULL AND archived = 0
       ORDER BY chain_position DESC LIMIT 1`
    ).get(chainId, currentPosition) as Record<string, unknown> | undefined;
    return row ? normalizeCard(row) : undefined;
  });
}

// returns the effective model for a card: card.model > board.default_model > 'opus'
export function getEffectiveModel(db: DatabaseInstance, cardId: number): ModelName {
  return withRetry(() => {
    const row = db.prepare(`
      SELECT c.model, b.default_model
      FROM cards c
      JOIN columns col ON col.id = c.column_id
      JOIN boards b ON b.id = col.board_id
      WHERE c.id = ?
    `).get(cardId) as { model: string | null; default_model: string } | undefined;
    return (row?.model ?? row?.default_model ?? 'opus') as ModelName;
  });
}
