// Database schema and initialization for Antfarm
// Creates SQLite tables, indexes, and seeds default board with pipeline columns

import { Database } from 'bun:sqlite';
import { PIPELINE_COLUMNS } from '../types.js';

export type DatabaseInstance = InstanceType<typeof Database>;

// creates or opens a sqlite database at the given path, enables wal mode,
// creates all required tables and indexes, and seeds default board data
export function initDatabase(dbPath: string): DatabaseInstance {
  const db = new Database(dbPath);

  // enable wal mode for better concurrent read/write performance
  db.exec('PRAGMA journal_mode = WAL');

  // set busy timeout to wait up to 3 seconds when the database is locked
  db.exec('PRAGMA busy_timeout = 3000');

  // enable foreign key enforcement
  db.exec('PRAGMA foreign_keys = ON');

  // Create all tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      directory TEXT,
      max_concurrency INTEGER NOT NULL DEFAULT 3 CHECK(max_concurrency BETWEEN 1 AND 20),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      color TEXT
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      column_id INTEGER REFERENCES columns(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      context TEXT,
      files TEXT,
      directory_path TEXT,
      git_branch TEXT,
      agent_status TEXT DEFAULT 'idle' CHECK(agent_status IN ('idle','working','waiting','errored','completed')),
      assigned_session TEXT,
      last_activity_at TEXT,
      archived INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      position INTEGER DEFAULT 0,
      spec TEXT,
      spec_status TEXT DEFAULT 'pending' CHECK(spec_status IN ('pending','generating','ready','approved')),
      plan_status TEXT DEFAULT 'none' CHECK(plan_status IN ('none','generating','ready','approved','failed')),
      pr_url TEXT,
      pr_branch TEXT,
      worktree_path TEXT,
      claude_session_id TEXT
    );

    CREATE TABLE IF NOT EXISTS task_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
      version INTEGER NOT NULL DEFAULT 1,
      files_to_create TEXT NOT NULL DEFAULT '[]',
      files_to_modify TEXT NOT NULL DEFAULT '[]',
      steps TEXT NOT NULL DEFAULT '[]',
      estimated_scope TEXT NOT NULL DEFAULT 'medium' CHECK(estimated_scope IN ('small','medium','large')),
      dependencies TEXT NOT NULL DEFAULT '[]',
      feedback TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS card_deps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
      depends_on_card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
      UNIQUE(card_id, depends_on_card_id)
    );

    CREATE TABLE IF NOT EXISTS subtasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      completed INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      source TEXT DEFAULT 'user' CHECK(source IN ('user','agent')),
      type TEXT DEFAULT 'note' CHECK(type IN ('note','output','status_change','human_review_request')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER,
      action TEXT NOT NULL,
      actor TEXT DEFAULT 'user' CHECK(actor IN ('user','agent')),
      details_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      board_id INTEGER REFERENCES boards(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Indexes for common query patterns
    CREATE INDEX IF NOT EXISTS idx_cards_column_id ON cards(column_id);
    CREATE INDEX IF NOT EXISTS idx_cards_agent_status ON cards(agent_status);
    CREATE INDEX IF NOT EXISTS idx_cards_assigned_session ON cards(assigned_session);
    CREATE INDEX IF NOT EXISTS idx_card_deps_card_id ON card_deps(card_id);
    CREATE INDEX IF NOT EXISTS idx_card_deps_depends_on_card_id ON card_deps(depends_on_card_id);
    CREATE INDEX IF NOT EXISTS idx_activity_log_card_created ON activity_log(card_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_plans_card_id ON task_plans(card_id);
  `);

  // Migration: add plan_status column to existing cards table
  try {
    db.exec(`ALTER TABLE cards ADD COLUMN plan_status TEXT DEFAULT 'none' CHECK(plan_status IN ('none','generating','ready','approved','failed'))`);
  } catch { /* column already exists */ }

  // migration: chain support - links cards into ordered sequences that share claude sessions
  try { db.exec(`ALTER TABLE cards ADD COLUMN chain_id INTEGER REFERENCES chains(id) ON DELETE SET NULL`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE cards ADD COLUMN chain_position INTEGER`); } catch { /* already exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_cards_chain_id ON cards(chain_id)`); } catch { /* already exists */ }

  // migration: per-card model override and board-level default
  try { db.exec(`ALTER TABLE cards ADD COLUMN model TEXT`); } catch { /* already exists */ }
  try { db.exec(`ALTER TABLE boards ADD COLUMN default_model TEXT DEFAULT 'opus'`); } catch { /* already exists */ }
  // Migration: add max_concurrency to boards
  try { db.exec(`ALTER TABLE boards ADD COLUMN max_concurrency INTEGER DEFAULT 3`); } catch { /* already exists */ }
  try { db.exec(`UPDATE boards SET max_concurrency = 3 WHERE max_concurrency IS NULL`); } catch { /* non-critical */ }
  // Backfill existing boards that have NULL default_model
  try { db.exec(`UPDATE boards SET default_model = 'opus' WHERE default_model IS NULL`); } catch { /* non-critical */ }

  // Migration: add Planning and Plan Review columns to existing boards
  const existingBoards = db.prepare('SELECT id FROM boards').all() as { id: number }[];
  for (const board of existingBoards) {
    const hasPlanningCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Planning'").get(board.id);
    if (!hasPlanningCol) {
      // Shift Building, Reviewing, Done positions to make room
      db.prepare(
        "UPDATE columns SET position = position + 2 WHERE board_id = ? AND name IN ('Building', 'Reviewing', 'Done')"
      ).run(board.id);
      const specReadyCol = db.prepare("SELECT position FROM columns WHERE board_id = ? AND name = 'Spec Ready'").get(board.id) as { position: number } | undefined;
      const basePos = (specReadyCol?.position ?? 2) + 1;
      db.prepare('INSERT INTO columns (board_id, name, position, color) VALUES (?, ?, ?, ?)').run(board.id, 'Planning', basePos, '#a855f7');
      db.prepare('INSERT INTO columns (board_id, name, position, color) VALUES (?, ?, ?, ?)').run(board.id, 'Plan Review', basePos + 1, '#d946ef');
    }
  }

  // migration: remove legacy "Approved" column (replaced by Planning/Plan Review)
  for (const board of existingBoards) {
    const approvedCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Approved'").get(board.id) as { id: number } | undefined;
    if (approvedCol) {
      // move any cards stuck in Approved to Spec Ready
      const specReadyCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Spec Ready'").get(board.id) as { id: number } | undefined;
      if (specReadyCol) {
        db.prepare('UPDATE cards SET column_id = ? WHERE column_id = ?').run(specReadyCol.id, approvedCol.id);
      }
      db.prepare('DELETE FROM columns WHERE id = ?').run(approvedCol.id);
    }
  }

  // Seed a default board with pipeline columns if no boards exist yet
  const boardCount = db.prepare('SELECT COUNT(*) as count FROM boards').get() as { count: number };

  if (boardCount.count === 0) {
    const insertBoard = db.prepare('INSERT INTO boards (name) VALUES (?)');
    const insertColumn = db.prepare('INSERT INTO columns (board_id, name, position, color) VALUES (?, ?, ?, ?)');

    const seedDefault = db.transaction(() => {
      const result = insertBoard.run('Default');
      const boardId = result.lastInsertRowid;

      // Create pipeline columns matching the task pipeline stages
      for (let i = 0; i < PIPELINE_COLUMNS.length; i++) {
        const col = PIPELINE_COLUMNS[i];
        insertColumn.run(boardId, col.name, i, col.color);
      }
    });

    seedDefault();
  }

  return db;
}
