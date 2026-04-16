// Dashboard HTTP server for Antfarm, built on Hono.
// Serves the React dashboard, REST API, and SSE event stream.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { initDatabase } from '../db/schema.js';
import {
  getBoards,
  getBoardWithColumns,
  getAllBoardCards,
  getCard,
  createCard,
  updateCard,
  archiveCard,
  getSubtasks,
  getNotes,
  addNote,
  addSubtask,
  completeSubtask,
  toggleSubtask,
  releaseStaleCards,
  getLatestPlan,
  updatePlanStatus,
  rejectPlan,
  getPlanCount,
  createChain,
  getChain,
  getChainsForBoard,
  updateChain as updateChainQuery,
  deleteChain,
  addCardToChain,
  removeCardFromChain,
  reorderChainCards,
} from '../db/queries.js';
import { getBlockers, getDependents } from '../db/deps.js';
import { spawnSpecGeneration, spawnImplementation, spawnPlanner, buildClaudeArgs, parseStreamJsonOutput } from '../spawner.js';
import { PIPELINE_COLUMNS } from '../types.js';
import { agentPool } from '../pool.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec, execSync, spawn } from 'child_process';
import { setupPtyWebSocket, cleanupAllPtySessions } from './pty.js';
import { killProcess } from './process-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Extracts clean markdown spec text from raw Claude CLI JSON output.
// The spawner sometimes stored the entire JSONL/JSON array output instead
// of just the extracted spec text.
function cleanSpecContent(spec: string): string {
  const trimmed = spec.trim();
  // If it doesn't look like raw JSON output, it's already clean
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return spec;

  try {
    const parsed = JSON.parse(trimmed);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    let specText = '';

    for (const parsed of items) {
      if (parsed.type === 'result' && parsed.result) {
        specText = parsed.result;
      }
      if (parsed.type === 'assistant' && parsed.message?.content) {
        const textContent = parsed.message.content.find((c: any) => c.type === 'text');
        if (textContent?.text) {
          specText = textContent.text;
        }
      }
    }

    return specText || spec;
  } catch {
    return spec;
  }
}

// Track SSE writers for broadcasting
type SSEWriter = { write: (data: string) => void; close: () => void };
const sseClients: Set<SSEWriter> = new Set();
let lastActivityId = 0;

function broadcastSSE(event: { type: string; data: Record<string, unknown> }) {
  const payload = JSON.stringify(event);
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function startDashboardServer(dbPath: string, port: number): Promise<number> {
  const db = initDatabase(dbPath);
  const app = new Hono();

  // auth middleware: when ANTFARM_API_KEY is set, all requests need the token
  const apiKey = process.env.ANTFARM_API_KEY;
  if (apiKey) {
    app.use('*', async (c, next) => {
      const url = new URL(c.req.url);

      // skip auth for static files (html, css, js, icons, manifest)
      if (url.pathname === '/' || url.pathname.startsWith('/assets/') || url.pathname === '/manifest.json' ||
          url.pathname === '/sw.js' || url.pathname.endsWith('.png') || url.pathname === '/mobile') {
        return next();
      }

      const token = c.req.header('Authorization')?.replace('Bearer ', '') ||
                    url.searchParams.get('token');
      if (token !== apiKey) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    });
    console.log('[antfarm] API key auth enabled');
  }

  // ── Fix existing specs that contain raw JSON output ──
  try {
    const badSpecs = db.prepare("SELECT id, spec FROM cards WHERE spec IS NOT NULL AND spec LIKE '[{%'").all() as { id: number; spec: string }[];
    for (const row of badSpecs) {
      const cleaned = cleanSpecContent(row.spec);
      if (cleaned !== row.spec) {
        db.prepare("UPDATE cards SET spec = ?, updated_at = datetime('now') WHERE id = ?").run(cleaned, row.id);
      }
    }
    if (badSpecs.length > 0) {
      console.log(`[antfarm] Fixed ${badSpecs.length} spec(s) with raw JSON content`);
    }
  } catch { /* non-critical */ }

  // ── Pool initialization ──
  // Load concurrency limits from all boards and initialize pool state
  try {
    const allBoards = db.prepare('SELECT id, max_concurrency FROM boards').all() as { id: number; max_concurrency: number }[];
    for (const b of allBoards) {
      agentPool.setLimit(b.id, b.max_concurrency);
    }
  } catch { /* non-critical */ }

  // Reset orphaned "waiting" cards to idle on startup (queue is in-memory)
  try {
    const waitingCards = db.prepare("SELECT id FROM cards WHERE agent_status = 'waiting'").all() as { id: number }[];
    if (waitingCards.length > 0) {
      const resetStmt = db.prepare("UPDATE cards SET agent_status = 'idle', updated_at = datetime('now') WHERE id = ?");
      for (const c of waitingCards) {
        resetStmt.run(c.id);
      }
      console.log(`[antfarm] Reset ${waitingCards.length} orphaned waiting card(s) to idle`);
    }
  } catch { /* non-critical */ }

  // Broadcast pool status changes via SSE
  agentPool.setStatusListener((boardId, status) => {
    broadcastSSE({ type: 'pool_status', data: { board_id: boardId, ...status } });
  });

  // ── SSE endpoint ──
  app.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
      const writer: SSEWriter = {
        write: (data: string) => { stream.write(data); },
        close: () => { sseClients.delete(writer); },
      };
      sseClients.add(writer);

      await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }) });

      // Keep alive until client disconnects
      while (true) {
        await stream.sleep(30000);
        await stream.writeSSE({ data: '{"type":"ping"}' });
      }
    });
  });

  // ── Board routes ──
  app.get('/api/boards', (c) => {
    return c.json(getBoards(db));
  });

  // Create a new board with pipeline columns
  app.post('/api/boards', async (c) => {
    const body = await c.req.json();
    const name = body.name as string;
    if (!name?.trim()) return c.json({ error: 'Board name required' }, 400);

    const result = db.prepare('INSERT INTO boards (name) VALUES (?)').run(name.trim());
    const boardId = Number(result.lastInsertRowid);

    // Create pipeline columns from shared constant
    const insertCol = db.prepare('INSERT INTO columns (board_id, name, position, color) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < PIPELINE_COLUMNS.length; i++) {
      const col = PIPELINE_COLUMNS[i];
      insertCol.run(boardId, col.name, i, col.color);
    }

    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId);
    broadcastSSE({ type: 'board.updated', data: { board } });
    return c.json(board, 201);
  });

  app.get('/api/boards/:id', (c) => {
    const id = Number(c.req.param('id'));
    const result = getBoardWithColumns(db, id);
    if (!result) return c.json({ error: 'Board not found' }, 404);
    const cards = getAllBoardCards(db, id);
    const chains = getChainsForBoard(db, id);
    return c.json({ ...result, cards, chains });
  });

  // Set board directory
  app.post('/api/boards/:id/directory', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    const directory = body.directory as string;
    if (!directory || !fs.existsSync(directory)) {
      return c.json({ error: 'Directory does not exist' }, 400);
    }
    db.prepare('UPDATE boards SET directory = ?, updated_at = datetime(\'now\') WHERE id = ?').run(directory, id);
    broadcastSSE({ type: 'board.updated', data: { board_id: id, directory } });
    return c.json({ success: true, directory });
  });

  // Update board configuration (max_concurrency, default_model)
  app.patch('/api/boards/:id/config', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    const board = db.prepare('SELECT id FROM boards WHERE id = ?').get(id) as any;
    if (!board) return c.json({ error: 'Board not found' }, 404);

    const updates: Record<string, unknown> = {};

    if (body.max_concurrency != null) {
      const maxConcurrency = body.max_concurrency;
      if (typeof maxConcurrency !== 'number' || maxConcurrency < 1 || maxConcurrency > 20) {
        return c.json({ error: 'max_concurrency must be a number between 1 and 20' }, 400);
      }
      db.prepare("UPDATE boards SET max_concurrency = ?, updated_at = datetime('now') WHERE id = ?").run(maxConcurrency, id);
      agentPool.setLimit(id, maxConcurrency);
      updates.max_concurrency = maxConcurrency;
    }

    if (body.default_model != null) {
      if (typeof body.default_model !== 'string' || !body.default_model.trim()) {
        return c.json({ error: 'default_model must be a non-empty string' }, 400);
      }
      db.prepare("UPDATE boards SET default_model = ?, updated_at = datetime('now') WHERE id = ?").run(body.default_model.trim(), id);
      updates.default_model = body.default_model.trim();
    }

    broadcastSSE({ type: 'board.updated', data: { board_id: id, ...updates } });
    return c.json({ success: true, ...updates });
  });

  // Get pool status for a board
  app.get('/api/boards/:id/pool', (c) => {
    const id = Number(c.req.param('id'));
    return c.json(agentPool.getStatus(id));
  });

  // ── Claude Code stats (reads ~/.claude/stats-cache.json) ──
  app.get('/api/claude-stats', (c) => {
    const statsPath = path.join(process.env.HOME ?? '~', '.claude', 'stats-cache.json');
    try {
      if (!fs.existsSync(statsPath)) return c.json({ models: [], usage: null });
      const raw = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));

      // Extract available models from modelUsage keys
      const modelUsage = raw.modelUsage ?? {};
      const models = Object.keys(modelUsage).map(id => {
        // Parse model family and alias from full ID
        let alias = id;
        if (id.includes('opus')) alias = 'opus';
        else if (id.includes('sonnet')) alias = 'sonnet';
        else if (id.includes('haiku')) alias = 'haiku';

        const stats = modelUsage[id];
        return {
          id,
          alias,
          inputTokens: stats.inputTokens ?? 0,
          outputTokens: stats.outputTokens ?? 0,
          cacheReadTokens: stats.cacheReadInputTokens ?? 0,
          cacheCreationTokens: stats.cacheCreationInputTokens ?? 0,
        };
      });

      // Get recent daily usage (last 7 days)
      const daily = (raw.dailyModelTokens ?? []).slice(-7);

      return c.json({ models, daily });
    } catch {
      return c.json({ models: [], daily: [] });
    }
  });

  // ── Chain routes ──

  app.get('/api/boards/:id/chains', (c) => {
    const id = Number(c.req.param('id'));
    return c.json(getChainsForBoard(db, id));
  });

  app.post('/api/chains', async (c) => {
    const body = await c.req.json();
    const { board_id, name } = body;
    if (!board_id || !name?.trim()) return c.json({ error: 'board_id and name required' }, 400);
    const chain = createChain(db, board_id, name.trim());
    broadcastSSE({ type: 'board.updated', data: { board_id } });
    return c.json(chain, 201);
  });

  app.get('/api/chains/:id', (c) => {
    const id = Number(c.req.param('id'));
    const result = getChain(db, id);
    if (!result) return c.json({ error: 'Chain not found' }, 404);
    return c.json(result);
  });

  app.patch('/api/chains/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    if (!body.name?.trim()) return c.json({ error: 'name required' }, 400);
    const chain = updateChainQuery(db, id, body.name.trim());
    if (!chain) return c.json({ error: 'Chain not found' }, 404);
    return c.json(chain);
  });

  app.delete('/api/chains/:id', (c) => {
    const id = Number(c.req.param('id'));
    const result = getChain(db, id);
    if (!result) return c.json({ error: 'Chain not found' }, 404);
    deleteChain(db, id);
    broadcastSSE({ type: 'board.updated', data: { board_id: result.chain.board_id } });
    return c.json({ success: true });
  });

  app.post('/api/chains/:id/cards', async (c) => {
    const chainId = Number(c.req.param('id'));
    const body = await c.req.json();
    const cardId = body.card_id;
    if (!cardId) return c.json({ error: 'card_id required' }, 400);
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);
    if (card.chain_id) return c.json({ error: 'Card already in a chain' }, 409);
    addCardToChain(db, chainId, cardId, body.position);
    broadcastSSE({ type: 'card.updated', data: { card_id: cardId } });
    return c.json({ success: true });
  });

  app.delete('/api/chains/:id/cards/:cardId', (c) => {
    const cardId = Number(c.req.param('cardId'));
    removeCardFromChain(db, cardId);
    broadcastSSE({ type: 'card.updated', data: { card_id: cardId } });
    return c.json({ success: true });
  });

  app.patch('/api/chains/:id/reorder', async (c) => {
    const chainId = Number(c.req.param('id'));
    const body = await c.req.json();
    const cardIds = body.card_ids as number[];
    if (!Array.isArray(cardIds)) return c.json({ error: 'card_ids array required' }, 400);
    try {
      reorderChainCards(db, chainId, cardIds);
      return c.json({ success: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // Get project context (CLAUDE.md files) for a board
  app.get('/api/boards/:id/context', (c) => {
    const id = Number(c.req.param('id'));
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as any;
    if (!board?.directory) return c.json({ context: null, error: 'No directory set' });

    const claudeMdFiles: { path: string; content: string }[] = [];
    function scanDir(dir: string, depth: number) {
      if (depth > 3) return; // limit recursion
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isFile() && entry.name.toUpperCase() === 'CLAUDE.MD') {
            claudeMdFiles.push({ path: fullPath, content: fs.readFileSync(fullPath, 'utf-8') });
          } else if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          }
        }
      } catch { /* permission errors, etc */ }
    }
    scanDir(board.directory, 0);
    return c.json({ context: claudeMdFiles });
  });

  // ── Card routes ──
  app.post('/api/cards', async (c) => {
    try {
      const body = await c.req.json();
      const card = createCard(db, body);
      broadcastSSE({ type: 'card.created', data: { card } });
      return c.json(card, 201);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.get('/api/cards/:id', (c) => {
    const card = getCard(db, Number(c.req.param('id')));
    if (!card) return c.json({ error: 'Card not found' }, 404);
    const subtasks = getSubtasks(db, card.id);
    const notes = getNotes(db, card.id);
    const blockers = getBlockers(db, card.id);
    const dependents = getDependents(db, card.id);

    // Get git status for the card's directory
    let gitInfo: { branch: string; dirty: boolean; ahead: number; behind: number } | null = null;
    const dir = card.directory_path || card.worktree_path;
    if (dir) {
      try {
        const gitOpts = { cwd: dir, timeout: 3000, stdio: 'pipe' as const };
        const branch = execSync('git rev-parse --abbrev-ref HEAD', gitOpts).toString().trim();
        const status = execSync('git status --porcelain', gitOpts).toString().trim();
        let ahead = 0, behind = 0;
        try {
          const ab = execSync('git rev-list --left-right --count HEAD...@{upstream}', gitOpts).toString().trim();
          const parts = ab.split('\t');
          ahead = parseInt(parts[0]) || 0;
          behind = parseInt(parts[1]) || 0;
        } catch { /* no upstream - branch not pushed yet, that's fine */ }
        gitInfo = { branch, dirty: status.length > 0, ahead, behind };
      } catch { /* not a git repo or dir doesn't exist */ }
    }

    // Clean spec if it contains raw JSON from Claude CLI output
    const cleanedSpec = card.spec ? cleanSpecContent(card.spec) : null;
    return c.json({ ...card, spec: cleanedSpec, subtasks, notes, blockers, dependents, git: gitInfo });
  });

  app.patch('/api/cards/:id', async (c) => {
    const body = await c.req.json();
    const card = updateCard(db, Number(c.req.param('id')), body);
    if (!card) return c.json({ error: 'Card not found' }, 404);
    broadcastSSE({ type: 'card.updated', data: { card } });
    return c.json(card);
  });

  app.delete('/api/cards/:id', (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);

    // Kill any running process and release pool
    killProcess(cardId);
    agentPool.cancelQueued(cardId);
    const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(card.column_id) as any;
    if (col?.board_id && agentPool.isActive(cardId)) {
      agentPool.release(col.board_id, cardId);
    }

    // If the card is working or waiting, force-reset it first so archiveCard accepts it
    if (card.agent_status === 'working' || card.agent_status === 'waiting') {
      db.prepare("UPDATE cards SET agent_status = 'idle', assigned_session = NULL, updated_at = datetime('now') WHERE id = ?").run(cardId);
    }

    const result = archiveCard(db, cardId);
    if (!result.success) return c.json({ error: 'Cannot archive' }, 400);
    broadcastSSE({ type: 'card.updated', data: { card_id: cardId, archived: true } });
    return c.json(result);
  });

  // ── Seed tasks ──
  // Product roadmap items for dev experience and Claude Code productivity
  const SEED_TASKS = [
    { title: 'Auto-pickup: agents claim idle cards autonomously', description: 'Add an MCP tool (antfarm_get_next_available) that returns the highest-priority unblocked idle card. Agents poll this to autonomously pick up work from Idea/Approved columns, respecting dependency order.', context: 'src/mcp/server.ts has tool registration. src/db/deps.ts checks dependencies. Add priority ordering by card position.' },
    { title: 'Parallel agent pool with configurable concurrency', description: 'Spawn N agents working on independent cards simultaneously. Add a pool manager tracking active count and queuing work at capacity. Expose concurrency setting in board config.', context: 'spawner.ts spawns one process per card with no limits. Add a pool module with configurable max concurrent claude processes.' },
    { title: 'Spec templates per task type', description: 'Let users choose a spec template when creating a task (API endpoint, UI component, refactor, bugfix). Each template guides Claude with targeted prompts for that task type.', context: 'Spec prompt is hardcoded in spawner.ts spawnSpecGeneration(). Add template dropdown to CreateTaskModal.tsx, store template type in card.context field.' },
    { title: 'Implementation plan preview before building', description: 'After approving a spec, show a dry-run plan (files to create/modify, estimated scope) before committing to the full build. User reviews the plan before the agent starts coding.', context: 'Add a step between Approved and Building. Spawn claude with a lighter prompt for just the plan. Store as structured note. Show in CardDetail before allowing build.' },
    { title: 'Test generation and validation gate', description: 'Auto-generate tests during implementation. Run them and show pass/fail in the review phase. Block cards from Done if tests fail.', context: 'Modify implementation prompt in spawner.ts to require tests. Parse codex review output for test results. Add test_status to card notes.' },
    { title: 'Quick board filters and persistent search', description: 'Add filter bar to filter cards by agent_status, spec_status, or text search. Persist filter state in URL params so filters survive page refresh.', context: 'Board gets crowded. CommandPalette (Cmd+K) exists but no persistent filtering. Add filter state to App.tsx, pass to Board for cardsByColumn filtering.' },
    { title: 'Global activity feed panel', description: 'Toggleable side panel showing real-time scrolling feed of all agent actions across the board: specs generated, builds started, errors, PR submissions.', context: 'activity_log table has all events. SSE poller already broadcasts them. Add collapsible panel in App.tsx subscribing to SSE events with timeline UI.' },
    { title: 'Desktop notifications for key events', description: 'Browser desktop notifications when a spec is ready, implementation completes, or an agent errors. Respect browser permission, add a toggle in header.', context: 'Use Web Notifications API. Hook into SSE events in useSSE.ts — on card.spec_ready or card.errored events, show notification.' },
    { title: 'Auto-branch creation when building starts', description: 'Automatically create and checkout a feature branch named from card title (e.g. feat/add-oauth-login) when a card moves to Building.', context: 'simple-git is already a dependency. In spawnImplementation(), create branch before spawning claude. Store in card.git_branch. Slugify title.' },
    { title: 'GitHub PR status sync on cards', description: 'Poll GitHub for PR review status (approved, changes requested, merged) and reflect on the card badge. Auto-move to Done when PR merges.', context: 'Cards have pr_url field. Use GitHub API or gh CLI. Add poller in server/index.ts alongside stale-card watchdog.' },
    { title: 'Board analytics dashboard', description: 'Charts showing throughput (cards done/week), average time per stage, agent success rate, and error rate over time.', context: 'activity_log has timestamps for all transitions. Query durations by diffing consecutive card.moved events. Render with recharts or SVG.' },
    { title: 'Card time tracking with stage duration badges', description: 'Track time per pipeline stage. Show elapsed time badges on cards and a stage timeline in card detail modal.', context: 'activity_log records card.moved events. Compute durations by diffing consecutive transitions. Show relative time (2h, 3d) on badges.' },
    { title: 'MCP tool: request human review', description: 'Add antfarm_request_human_review so agents can pause and flag a card for human attention with a specific question, setting agent_status=waiting.', context: 'Add to src/mcp/server.ts. Set status to waiting, add note with question, highlight waiting cards with distinct badge in dashboard.' },
    { title: 'MCP tool: split card into subtasks', description: 'Add antfarm_split_card so agents can decompose a large card into smaller sub-cards during speccing, with dependency links between parent and children.', context: 'Add to src/mcp/server.ts. Create new cards in Idea column linked via card_deps. Show children in parent CardDetail.' },
    { title: 'Card dependency visualization in detail view', description: 'Render blocking relationships as a visual graph in card detail. Show blockers and dependents with status indicators and clickable links.', context: 'card_deps table tracks dependencies. CardDetail fetches blockers/dependents but does not display them. Add a simple DAG visualization.' },
    { title: 'Bulk card operations with multi-select', description: 'Select multiple cards (Shift+click) and perform bulk move, archive, or re-spec. Show floating action bar when multiple cards are selected.', context: 'All card actions are one-at-a-time. No multi-select in Board.tsx. Add selection state and batch API endpoints.' },
    { title: 'Webhook notifications for Slack/Discord/CI', description: 'Emit webhooks on card state transitions. Add webhooks config per board with URL and event filter.', context: 'SSE broadcasts internally. Add webhooks table (board_id, url, events). On broadcastSSE, POST to configured URLs.' },
    { title: 'Board-level CLAUDE.md editor', description: 'Inline editor in board settings to view and edit the project CLAUDE.md directly from the dashboard.', context: 'GET /api/boards/:id/context scans for CLAUDE.md files. Add write endpoint and Monaco-style editor component.' },
    { title: 'Graceful shutdown with agent state preservation', description: 'On server stop, safely pause running agents and persist state for resume on restart instead of killing processes.', context: 'process.on SIGTERM calls cleanupAllPtySessions. Extend to update working cards to paused state with resume info.' },
    { title: 'Health check endpoint and status page', description: 'Add GET /api/health returning DB status, uptime, active agent count, total cards, version. Add a /status page in the UI.', context: 'No health endpoint exists. Server on Hono port 4800. Active agents = cards with agent_status=working.' },
  ];

  app.post('/api/boards/:id/seed-tasks', (c) => {
    const boardId = Number(c.req.param('id'));
    const result = getBoardWithColumns(db, boardId);
    if (!result) return c.json({ error: 'Board not found' }, 404);

    const { columns } = result;
    const ideaColumn = columns.find(col => col.name === 'Idea');
    if (!ideaColumn) return c.json({ error: 'Board has no Idea column' }, 400);

    const existingCards = db
      .prepare('SELECT title FROM cards WHERE column_id = ? AND archived = 0')
      .all(ideaColumn.id) as { title: string }[];
    const existingTitles = new Set(existingCards.map(c => c.title));

    const created: any[] = [];
    let skipped = 0;

    for (const task of SEED_TASKS) {
      if (existingTitles.has(task.title)) {
        skipped++;
        continue;
      }
      const card = createCard(db, {
        column_id: ideaColumn.id,
        title: task.title,
        description: task.description,
        context: task.context,
      });
      created.push(card);
    }

    if (created.length > 0) {
      broadcastSSE({ type: 'board.updated', data: { board_id: boardId } });
    }

    return c.json({ created: created.length, skipped, cards: created });
  });

  // ── Suggest tasks (AI-powered codebase analysis) ──
  app.post('/api/boards/:id/suggest-tasks', async (c) => {
    const boardId = Number(c.req.param('id'));
    const result = getBoardWithColumns(db, boardId);
    if (!result) return c.json({ error: 'Board not found' }, 404);
    if (!result.board.directory) return c.json({ error: 'Board has no directory set' }, 400);

    const { columns } = result;
    const directory = result.board.directory!;
    const ideaColumn = columns.find(col => col.name === 'Idea');
    if (!ideaColumn) return c.json({ error: 'Board has no Idea column' }, 400);

    // Get all non-archived card titles for deduplication
    const existingCards = db.prepare(
      `SELECT c.title FROM cards c
       JOIN columns col ON col.id = c.column_id
       WHERE col.board_id = ? AND c.archived = 0`
    ).all(boardId) as { title: string }[];
    const existingTitlesSet = new Set(existingCards.map(c => c.title.toLowerCase()));

    // Get recent git log for context
    let gitLog = '';
    try {
      gitLog = execSync('git log --oneline -50', { cwd: directory, timeout: 5000, stdio: 'pipe' }).toString().trim();
    } catch { /* not a git repo or dir doesn't exist */ }

    const existingTitlesList = existingCards.map(c => c.title).join('\n- ');

    const prompt = [
      `You are an expert software engineer analyzing a codebase to suggest high-impact improvements.`,
      ``,
      `First: read all CLAUDE.md files in this project to understand the codebase, patterns, and conventions.`,
      `Then: analyze the codebase structure, patterns, and recent development activity.`,
      ``,
      `## Recent git history:`,
      gitLog || '(no git history available)',
      ``,
      `## Existing tasks on the board (avoid duplicates):`,
      existingTitlesList ? `- ${existingTitlesList}` : '(no existing tasks)',
      ``,
      `## Instructions:`,
      `Generate exactly 5 high-impact task suggestions. Focus on:`,
      `- Agent coordination improvements`,
      `- Pipeline automation enhancements`,
      `- Feedback loops and iteration speed`,
      `- Developer productivity for Claude Code users`,
      `- Code quality, testing, and reliability improvements`,
      ``,
      `Each task should be specific, actionable, and grounded in the actual codebase.`,
      `Do NOT suggest tasks that duplicate or overlap with existing tasks listed above.`,
      ``,
      `Output ONLY a valid JSON array of exactly 5 objects, each with "title" and "description" fields.`,
      `The title should be concise (under 80 chars). The description should be 2-3 sentences explaining what to build and why.`,
      `No markdown fences, no explanation — just the JSON array.`,
    ].join('\n');

    try {
      const agentOutput = await new Promise<string>((resolve, reject) => {
        const child = spawn('claude', buildClaudeArgs(prompt), {
          cwd: directory,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(stderr.trim() || `Claude process exited with code ${code}`));
            return;
          }
          const { resultText } = parseStreamJsonOutput(stdout);
          resolve(resultText);
        });
      });

      // Parse the JSON array of tasks
      let tasks: { title: string; description: string }[] = [];
      try {
        tasks = JSON.parse(agentOutput.trim());
      } catch {
        // Regex fallback: extract JSON array from output
        const match = agentOutput.match(/\[[\s\S]*\]/);
        if (match) {
          try { tasks = JSON.parse(match[0]); } catch {}
        }
      }

      if (!Array.isArray(tasks) || tasks.length === 0) {
        return c.json({ error: 'Could not parse suggestions from agent output' }, 500);
      }

      // Create cards, skipping duplicates
      const created: any[] = [];
      for (const task of tasks) {
        if (!task.title || !task.description) continue;
        if (existingTitlesSet.has(task.title.toLowerCase())) continue;

        const card = createCard(db, {
          column_id: ideaColumn.id,
          title: task.title,
          description: task.description,
        });
        created.push(card);
        // Track the new title so subsequent tasks in the same batch don't duplicate
        existingTitlesSet.add(task.title.toLowerCase());
      }

      if (created.length > 0) {
        broadcastSSE({ type: 'board.updated', data: { board_id: boardId } });
      }

      return c.json({ created: created.length, cards: created });
    } catch (err: any) {
      return c.json({ error: `Failed to generate suggestions: ${err.message}` }, 500);
    }
  });

  // ── Pipeline actions ──

  // Reset a stuck/errored card back to Idea column with idle status
  app.post('/api/cards/:id/reset', (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);

    // Kill any running process for this card
    const killed = killProcess(cardId);

    // Cancel queued pool entry if waiting
    agentPool.cancelQueued(cardId);

    // Release pool slot if active
    const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(card.column_id) as any;
    if (col?.board_id && agentPool.isActive(cardId)) {
      agentPool.release(col.board_id, cardId);
    }

    const ideaCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Idea'").get(col?.board_id) as any;

    if (ideaCol) {
      db.prepare(
        "UPDATE cards SET column_id = ?, agent_status = 'idle', spec_status = 'pending', plan_status = 'none', assigned_session = NULL, updated_at = datetime('now') WHERE id = ?"
      ).run(ideaCol.id, cardId);
    } else {
      db.prepare(
        "UPDATE cards SET agent_status = 'idle', spec_status = 'pending', plan_status = 'none', assigned_session = NULL, updated_at = datetime('now') WHERE id = ?"
      ).run(cardId);
    }

    db.prepare(
      "INSERT INTO activity_log (card_id, action, actor) VALUES (?, 'card.reset', 'user')"
    ).run(cardId);

    broadcastSSE({ type: 'card.updated', data: { card_id: cardId } });
    return c.json({ success: true, killed });
  });

  // Trigger spec generation for a card
  app.post('/api/cards/:id/generate-spec', async (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);
    if (card.agent_status === 'working' || card.agent_status === 'waiting') {
      return c.json({ error: 'Card already has an active or queued agent session' }, 409);
    }

    // Parse optional re-spec comment from request body
    let respecComment: string | undefined;
    try {
      const body = await c.req.json();
      respecComment = body.comment;
    } catch { /* no body is fine for initial spec generation */ }

    // Get board directory
    const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(card.column_id) as any;
    const boardId = col?.board_id as number;
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId) as any;
    if (!board?.directory) return c.json({ error: 'Board has no directory set. Set a project directory first.' }, 400);

    // Move card to Speccing column
    const speccingCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Speccing'").get(board.id) as any;

    // Check pool capacity to determine initial status
    const poolStatus = agentPool.getStatus(boardId);
    const isQueued = poolStatus.active >= poolStatus.max;
    const initialAgentStatus = isQueued ? 'waiting' : 'working';

    if (speccingCol) {
      db.prepare(`UPDATE cards SET column_id = ?, spec_status = 'generating', agent_status = '${initialAgentStatus}', updated_at = datetime('now') WHERE id = ?`)
        .run(speccingCol.id, cardId);
    }

    // Log activity
    db.prepare("INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, 'card.spec_generating', 'user', ?)")
      .run(cardId, isQueued ? JSON.stringify({ queued: true, pool: poolStatus }) : null);

    broadcastSSE({ type: 'card.updated', data: { card_id: cardId, spec_status: 'generating', agent_status: initialAgentStatus } });

    if (isQueued) {
      addNote(db, cardId, `Queued — waiting for pool slot (${poolStatus.active}/${poolStatus.max} active)`, 'agent', 'status_change');
    }

    // Acquire pool slot (may queue), then spawn
    agentPool.acquire(boardId, cardId).then(() => {
      // Slot acquired — transition to working if was waiting
      if (isQueued) {
        db.prepare("UPDATE cards SET agent_status = 'working', updated_at = datetime('now') WHERE id = ?").run(cardId);
        broadcastSSE({ type: 'card.updated', data: { card_id: cardId, agent_status: 'working' } });
      }

      try {
        const updatedCard = getCard(db, cardId);
        if (!updatedCard || updatedCard.archived) {
          agentPool.release(boardId, cardId);
          return;
        }
        spawnSpecGeneration(updatedCard, board.directory, dbPath, { respecComment, boardId });
      } catch (err: any) {
        agentPool.release(boardId, cardId);
        db.prepare("UPDATE cards SET agent_status = 'errored', updated_at = datetime('now') WHERE id = ?").run(cardId);
        addNote(db, cardId, `Failed to spawn: ${err.message}`, 'agent', 'status_change');
      }
    }).catch(() => {
      // Acquire rejected (cancelled from queue)
      db.prepare("UPDATE cards SET agent_status = 'idle', updated_at = datetime('now') WHERE id = ?").run(cardId);
    });

    return c.json({ success: true, queued: isQueued });
  });

  // Approve a spec and trigger plan generation (not building directly)
  app.post('/api/cards/:id/approve', async (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);
    if (!card.spec) return c.json({ error: 'Card has no spec to approve' }, 400);
    if (card.agent_status === 'working' || card.agent_status === 'waiting') {
      return c.json({ error: 'Card already has an active or queued agent session' }, 409);
    }

    // Get board directory
    const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(card.column_id) as any;
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(col?.board_id) as any;
    if (!board?.directory) return c.json({ error: 'Board has no directory set' }, 400);

    // Move to Planning column and spawn plan generation
    const planningCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Planning'").get(board.id) as any;
    if (planningCol) {
      db.prepare(
        "UPDATE cards SET column_id = ?, spec_status = 'approved', plan_status = 'generating', agent_status = 'working', updated_at = datetime('now') WHERE id = ?"
      ).run(planningCol.id, cardId);
    }

    db.prepare("INSERT INTO activity_log (card_id, action, actor) VALUES (?, 'card.approved', 'user')")
      .run(cardId);

    broadcastSSE({ type: 'card.plan_generating', data: { card_id: cardId, spec_status: 'approved', plan_status: 'generating' } });

    // Spawn plan generation (lightweight, no pool slot needed)
    try {
      const result = spawnPlanner(card, board.directory, dbPath);
      return c.json({ success: true, pid: result.pid });
    } catch (err: any) {
      updatePlanStatus(db, cardId, 'failed');
      db.prepare("UPDATE cards SET agent_status = 'errored', updated_at = datetime('now') WHERE id = ?").run(cardId);
      return c.json({ error: `Failed to spawn planner: ${err.message}` }, 500);
    }
  });

  // Get the current plan for a card
  app.get('/api/cards/:id/plan', (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);

    const plan = getLatestPlan(db, cardId);
    if (!plan) return c.json({ error: 'No plan found' }, 404);

    return c.json(plan);
  });

  // Approve a plan and trigger building
  app.post('/api/cards/:id/plan/approve', async (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);
    if (card.plan_status !== 'ready') return c.json({ error: 'No plan ready to approve' }, 400);
    if (card.agent_status === 'working' || card.agent_status === 'waiting') {
      return c.json({ error: 'Card already has an active agent session' }, 409);
    }

    // Get board directory
    const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(card.column_id) as any;
    const boardId = col?.board_id as number;
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId) as any;
    if (!board?.directory) return c.json({ error: 'Board has no directory set' }, 400);

    // Mark plan as approved
    updatePlanStatus(db, cardId, 'approved');

    // Check pool capacity
    const poolStatus = agentPool.getStatus(boardId);
    const isQueued = poolStatus.active >= poolStatus.max;
    const initialAgentStatus = isQueued ? 'waiting' : 'working';

    // Move to Building column
    const buildingCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Building'").get(board.id) as any;
    if (buildingCol) {
      db.prepare(`UPDATE cards SET column_id = ?, agent_status = '${initialAgentStatus}', updated_at = datetime('now') WHERE id = ?`)
        .run(buildingCol.id, cardId);
    }

    db.prepare("INSERT INTO activity_log (card_id, action, actor) VALUES (?, 'card.plan_approved', 'user')")
      .run(cardId);

    broadcastSSE({ type: 'card.plan_approved', data: { card_id: cardId, plan_status: 'approved', agent_status: initialAgentStatus } });

    if (isQueued) {
      addNote(db, cardId, `Queued — waiting for pool slot (${poolStatus.active}/${poolStatus.max} active)`, 'agent', 'status_change');
    }

    // Acquire pool slot, then spawn implementation
    agentPool.acquire(boardId, cardId).then(async () => {
      if (isQueued) {
        db.prepare("UPDATE cards SET agent_status = 'working', updated_at = datetime('now') WHERE id = ?").run(cardId);
        broadcastSSE({ type: 'card.updated', data: { card_id: cardId, agent_status: 'working' } });
      }

      try {
        const updatedCard = getCard(db, cardId);
        if (!updatedCard || updatedCard.archived) {
          agentPool.release(boardId, cardId);
          return;
        }
        await spawnImplementation(updatedCard, board.directory, dbPath, { boardId });
      } catch (err: any) {
        agentPool.release(boardId, cardId);
        db.prepare("UPDATE cards SET agent_status = 'errored', updated_at = datetime('now') WHERE id = ?").run(cardId);
        addNote(db, cardId, `Failed to spawn: ${err.message}`, 'agent', 'status_change');
      }
    }).catch(() => {
      db.prepare("UPDATE cards SET agent_status = 'idle', updated_at = datetime('now') WHERE id = ?").run(cardId);
    });

    return c.json({ success: true, queued: isQueued });
  });

  // Reject a plan with feedback and trigger re-planning
  app.post('/api/cards/:id/plan/reject', async (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);
    if (card.plan_status !== 'ready') return c.json({ error: 'No plan ready to reject' }, 400);

    // Check re-plan cap (max 3 attempts)
    const planCount = getPlanCount(db, cardId);
    if (planCount >= 3) {
      return c.json({ error: 'Maximum re-plan attempts reached (3). Please edit the spec and re-approve.' }, 400);
    }

    let feedback = '';
    try {
      const body = await c.req.json();
      feedback = body.feedback || '';
    } catch { /* no body */ }

    // Store feedback on the rejected plan
    rejectPlan(db, cardId, feedback);

    // Get board directory
    const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(card.column_id) as any;
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(col?.board_id) as any;
    if (!board?.directory) return c.json({ error: 'Board has no directory set' }, 400);

    // Move back to Planning column
    const planningCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Planning'").get(board.id) as any;
    if (planningCol) {
      db.prepare(
        "UPDATE cards SET column_id = ?, plan_status = 'generating', agent_status = 'working', updated_at = datetime('now') WHERE id = ?"
      ).run(planningCol.id, cardId);
    }

    addNote(db, cardId, `Plan rejected${feedback ? ': ' + feedback : ''}. Re-planning...`, 'user', 'status_change');
    db.prepare("INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, 'card.plan_rejected', 'user', ?)")
      .run(cardId, JSON.stringify({ feedback, version: planCount }));

    broadcastSSE({ type: 'card.plan_rejected', data: { card_id: cardId, plan_status: 'generating' } });

    // Spawn re-planning with feedback
    try {
      const result = spawnPlanner(card, board.directory, dbPath, { rejectionFeedback: feedback });
      return c.json({ success: true, pid: result.pid, version: planCount + 1 });
    } catch (err: any) {
      updatePlanStatus(db, cardId, 'failed');
      db.prepare("UPDATE cards SET agent_status = 'errored', updated_at = datetime('now') WHERE id = ?").run(cardId);
      return c.json({ error: `Failed to spawn planner: ${err.message}` }, 500);
    }
  });

  // Retry an errored card — reset state and re-spawn the agent process
  app.post('/api/cards/:id/retry', async (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);
    if (card.agent_status !== 'errored') {
      return c.json({ error: 'Card is not in errored state' }, 409);
    }

    // Get board and directory
    const col = db.prepare('SELECT board_id, name FROM columns WHERE id = ?').get(card.column_id) as any;
    const boardId = col?.board_id as number;
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId) as any;
    if (!board?.directory) return c.json({ error: 'Board has no directory set' }, 400);

    // Determine retry type from column or spec_status
    const columnName = col?.name as string;
    let retryType: 'spec' | 'build';
    if (columnName === 'Building' || card.spec_status === 'approved') {
      retryType = 'build';
    } else {
      retryType = 'spec';
    }

    // Check pool capacity
    const poolStatus = agentPool.getStatus(boardId);
    const isQueued = poolStatus.active >= poolStatus.max;
    const initialAgentStatus = isQueued ? 'waiting' : 'working';

    // Reset card state (preserve git_branch for build retries to reuse worktree)
    if (retryType === 'spec') {
      const speccingCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Speccing'").get(board.id) as any;
      db.prepare(
        `UPDATE cards SET agent_status = '${initialAgentStatus}', assigned_session = NULL, claude_session_id = NULL, last_activity_at = NULL, worktree_path = NULL, spec = NULL, spec_status = 'generating', column_id = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(speccingCol?.id ?? card.column_id, cardId);
    } else {
      const buildingCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Building'").get(board.id) as any;
      db.prepare(
        `UPDATE cards SET agent_status = '${initialAgentStatus}', assigned_session = NULL, claude_session_id = NULL, last_activity_at = NULL, column_id = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(buildingCol?.id ?? card.column_id, cardId);
    }

    // Log the retry
    addNote(db, cardId, `Retrying ${retryType === 'spec' ? 'spec generation' : 'implementation'} after error`, 'user', 'status_change');
    db.prepare(
      "INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, 'card.retried', 'user', ?)"
    ).run(cardId, JSON.stringify({ retry_type: retryType }));

    broadcastSSE({ type: 'card.updated', data: { card_id: cardId, agent_status: initialAgentStatus, retry_type: retryType } });

    if (isQueued) {
      addNote(db, cardId, `Queued — waiting for pool slot (${poolStatus.active}/${poolStatus.max} active)`, 'agent', 'status_change');
    }

    // Acquire pool slot (may queue), then spawn
    agentPool.acquire(boardId, cardId).then(async () => {
      if (isQueued) {
        db.prepare("UPDATE cards SET agent_status = 'working', updated_at = datetime('now') WHERE id = ?").run(cardId);
        broadcastSSE({ type: 'card.updated', data: { card_id: cardId, agent_status: 'working' } });
      }

      const updatedCard = getCard(db, cardId)!;
      try {
        if (retryType === 'spec') {
          spawnSpecGeneration(updatedCard, board.directory, dbPath, { boardId });
        } else {
          await spawnImplementation(updatedCard, board.directory, dbPath, { boardId });
        }
      } catch (err: any) {
        agentPool.release(boardId, cardId);
        db.prepare("UPDATE cards SET agent_status = 'errored', updated_at = datetime('now') WHERE id = ?").run(cardId);
        addNote(db, cardId, `Failed to spawn: ${err.message}`, 'agent', 'status_change');
      }
    }).catch(() => {
      db.prepare("UPDATE cards SET agent_status = 'idle', updated_at = datetime('now') WHERE id = ?").run(cardId);
    });

    return c.json({ success: true, retry_type: retryType, queued: isQueued });
  });

  // ── Subtask routes ──
  app.post('/api/cards/:id/subtasks', async (c) => {
    const body = await c.req.json();
    const subtask = addSubtask(db, Number(c.req.param('id')), body.text);
    return c.json(subtask, 201);
  });

  app.patch('/api/subtasks/:id/complete', (c) => {
    const subtask = completeSubtask(db, Number(c.req.param('id')));
    if (!subtask) return c.json({ error: 'Subtask not found' }, 404);
    return c.json(subtask);
  });

  // Toggle subtask completion state
  app.patch('/api/subtasks/:id/toggle', (c) => {
    const subtask = toggleSubtask(db, Number(c.req.param('id')));
    if (!subtask) return c.json({ error: 'Subtask not found' }, 404);
    return c.json(subtask);
  });

  // ── Note routes ──
  app.post('/api/cards/:id/notes', async (c) => {
    const body = await c.req.json();
    const note = addNote(db, Number(c.req.param('id')), body.content, body.source ?? 'user', body.type ?? 'note');
    return c.json(note, 201);
  });

  // ── Terminal launch ──
  // Opens Warp terminal via launch configuration so we can auto-run commands.
  // Creates a temp YAML config, triggers warp://launch/{name}, then cleans up.
  app.post('/api/open-terminal/:id', async (c) => {
    const card = getCard(db, Number(c.req.param('id')));

    // Get directory from card or from the board
    let dir = card?.directory_path || card?.worktree_path;
    if (!dir && card) {
      const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(card.column_id) as any;
      const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(col?.board_id) as any;
      dir = board?.directory;
    }
    if (!dir) return c.json({ error: 'No directory for this card' }, 400);

    const sessionId = card?.claude_session_id;
    const configDir = path.join(process.env.HOME ?? '~', '.warp', 'launch_configurations');
    const configName = `antfarm-${card?.id ?? 'tmp'}`;
    const configPath = path.join(configDir, `${configName}.yaml`);

    // Build launch configuration YAML
    const command = sessionId ? `claude --resume ${sessionId}` : '';
    const title = card?.title ? card.title.substring(0, 40) : 'Antfarm';
    const yaml = [
      '---',
      `name: "${configName}"`,
      'windows:',
      '  - tabs:',
      `      - title: "${title.replace(/"/g, "'")}"`,
      '        layout:',
      `          cwd: "${dir}"`,
      ...(command ? [
      '          commands:',
      `            - exec: "${command}"`,
      ] : []),
    ].join('\n');

    try {
      // Ensure config directory exists
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Write temp launch config
      fs.writeFileSync(configPath, yaml);

      // Open via Warp launch URL scheme
      await new Promise<void>((resolve, reject) => {
        exec(`open "warp://launch/${configName}"`, (err) => {
          if (err) reject(err); else resolve();
        });
      });

      // Clean up the temp config after Warp has had time to read it
      setTimeout(() => {
        try { fs.unlinkSync(configPath); } catch { /* already deleted */ }
      }, 5000);

      return c.json({ success: true, session_id: sessionId, config: configName });
    } catch (err: any) {
      // Fallback: try simple tab open without command
      try {
        await new Promise<void>((resolve, reject) => {
          exec(`open "warp://action/new_tab?path=${encodeURIComponent(dir)}"`, (err) => {
            if (err) reject(err); else resolve();
          });
        });
        return c.json({ success: true, session_id: sessionId, fallback: true });
      } catch {
        return c.json({ error: 'Failed to open terminal' }, 500);
      }
    }
  });

  // ── Native folder picker (macOS) ──
  // Opens the native macOS folder picker and returns the selected path
  app.post('/api/pick-directory', async (c) => {
    const result = await new Promise<string | null>((resolve) => {
      // Use osascript to open native macOS folder picker
      exec(
        `osascript -e 'set theFolder to choose folder with prompt "Select project directory"' -e 'return POSIX path of theFolder'`,
        { timeout: 60000 },
        (err, stdout) => {
          if (err) resolve(null);
          else resolve(stdout.trim().replace(/\/$/, '')); // remove trailing slash
        }
      );
    });
    if (!result) return c.json({ error: 'No directory selected' }, 400);
    return c.json({ directory: result });
  });

  // ── list remote branches for PR base selection ──
  app.get('/api/cards/:id/branches', (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);

    const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(card.column_id) as any;
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(col?.board_id) as any;
    const cwd = card.worktree_path || card.directory_path || board?.directory;
    if (!cwd) return c.json({ branches: [], default: 'main' });

    try {
      const raw = execSync('git branch -r --format="%(refname:short)"', { cwd, timeout: 5000, stdio: 'pipe' }).toString().trim();
      const branches = raw.split('\n').filter(Boolean).map(b => b.replace('origin/', '')).filter(b => b !== 'HEAD');
      const defaultBranch = branches.includes('main') ? 'main' : branches.includes('master') ? 'master' : branches[0] || 'main';
      return c.json({ branches, default: defaultBranch });
    } catch {
      return c.json({ branches: ['main'], default: 'main' });
    }
  });

  // ── PR creation: push branch and create github PR ──
  app.post('/api/cards/:id/create-pr', async (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);
    if (!card.worktree_path && !card.git_branch) {
      return c.json({ error: 'No worktree or branch for this card' }, 400);
    }

    const cwd = card.worktree_path || card.directory_path;
    if (!cwd || !fs.existsSync(cwd)) {
      return c.json({ error: 'Worktree directory not found' }, 400);
    }

    let body: any = {};
    try { body = await c.req.json(); } catch { /* no body is fine */ }
    const baseBranch = body.base || '';

    try {
      const pipeOpts = { cwd, timeout: 10000, stdio: 'pipe' as const };

      // commit any uncommitted changes
      try {
        execSync('git add -A', { ...pipeOpts });
        // use the diff to generate a meaningful commit message
        const shortDiff = execSync('git diff --cached --stat', pipeOpts).toString().trim();
        const commitMsg = shortDiff
          ? shortDiff.split('\n').pop()?.trim() || 'update files'
          : 'update files';
        execSync(`git commit -m "${commitMsg}"`, pipeOpts);
      } catch { /* nothing to commit is fine */ }

      // push the branch
      const branch = card.git_branch || execSync('git branch --show-current', pipeOpts).toString().trim();
      execSync(`git push -u origin ${branch}`, { ...pipeOpts, timeout: 30000 });

      // get the diff for claude to summarize
      const baseRef = baseBranch || 'main';
      const baseFlag = baseBranch ? ` --base ${baseBranch}` : '';
      let diff = '';
      try {
        diff = execSync(`git diff ${baseRef}...${branch}`, { ...pipeOpts, timeout: 10000 }).toString();
      } catch {
        try { diff = execSync('git diff HEAD~5', pipeOpts).toString(); } catch {}
      }
      // truncate diff to 8k chars to keep the prompt small
      if (diff.length > 8000) diff = diff.slice(0, 8000) + '\n... (truncated)';

      let diffStat = '';
      try { diffStat = execSync(`git diff ${baseRef}...${branch} --stat`, pipeOpts).toString().trim(); } catch {}

      // use claude to generate pr title and description from the actual code changes
      let prTitle = '';
      let prBody = '';
      try {
        const prompt = [
          'generate a pull request title and description for these code changes.',
          'output exactly two sections separated by ---',
          'first line: a short PR title (max 72 chars, no prefix, describe what changed)',
          'then ---',
          'then the PR description in markdown with: ## summary (2-3 sentences), ## changes (bullet list of what was added/modified/removed)',
          '',
          'diff stat:',
          diffStat,
          '',
          'diff:',
          diff,
        ].join('\n');

        const claudeOutput = execSync(
          `claude -p "${prompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" --output-format json --model haiku`,
          { ...pipeOpts, timeout: 60000 }
        ).toString().trim();

        // parse claude json output
        const parsed = JSON.parse(claudeOutput);
        const text = parsed.result || claudeOutput;
        const parts = text.split('---');
        if (parts.length >= 2) {
          prTitle = parts[0].trim().replace(/^#+\s*/, '').replace(/^title:\s*/i, '');
          prBody = parts.slice(1).join('---').trim();
        } else {
          prTitle = text.split('\n')[0].trim();
          prBody = text;
        }
      } catch {
        // fallback: use card title and spec
        prTitle = card.title;
        prBody = card.spec ? card.spec.slice(0, 500) : '';
      }

      if (!prTitle || prTitle === 'agent: implement changes') prTitle = card.title;

      // append file stats to description
      if (diffStat) {
        prBody += '\n\n## files changed\n```\n' + diffStat + '\n```';
      }

      // create the PR via temp files to avoid shell escaping
      const tmpDir = require('os').tmpdir();
      const titleFile = path.join(tmpDir, `antfarm-pr-title-${cardId}.txt`);
      const bodyFile = path.join(tmpDir, `antfarm-pr-body-${cardId}.txt`);
      fs.writeFileSync(titleFile, prTitle);
      fs.writeFileSync(bodyFile, prBody);

      const prOutput = execSync(
        `gh pr create --title "$(cat ${titleFile})" --body-file ${bodyFile} --head ${branch}${baseFlag}`,
        { ...pipeOpts, timeout: 20000 }
      ).toString().trim();

      try { fs.unlinkSync(titleFile); fs.unlinkSync(bodyFile); } catch {}

      // extract PR url from gh output
      const prUrl = prOutput.match(/https:\/\/github\.com\/[^\s]+/)?.[0] || prOutput;
      db.prepare("UPDATE cards SET pr_url = ?, pr_branch = ?, updated_at = datetime('now') WHERE id = ?")
        .run(prUrl, branch, cardId);
      addNote(db, cardId, `PR created: ${prUrl}`, 'agent', 'status_change');
      broadcastSSE({ type: 'card.pr_ready', data: { card_id: cardId, pr_url: prUrl, branch } });
      return c.json({ success: true, pr_url: prUrl, branch, title: prTitle });
    } catch (err: any) {
      const msg = err.stderr?.toString()?.trim() || err.message || 'Failed to create PR';
      return c.json({ error: msg }, 500);
    }
  });

  // ── work on PR: send a prompt to claude in the card's worktree ──
  app.post('/api/cards/:id/work-on-pr', async (c) => {
    const cardId = Number(c.req.param('id'));
    const card = getCard(db, cardId);
    if (!card) return c.json({ error: 'Card not found' }, 404);

    const body = await c.req.json();
    const prompt = body.prompt as string;
    if (!prompt?.trim()) return c.json({ error: 'prompt required' }, 400);

    const cwd = card.worktree_path || card.directory_path;
    const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(card.column_id) as any;
    const boardId = col?.board_id as number;
    const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId) as any;
    const dir = cwd && fs.existsSync(cwd) ? cwd : board?.directory;

    if (!dir) return c.json({ error: 'No working directory for this card' }, 400);

    // set card to working state
    db.prepare("UPDATE cards SET agent_status = 'working', updated_at = datetime('now') WHERE id = ?").run(cardId);
    broadcastSSE({ type: 'card.updated', data: { card_id: cardId, agent_status: 'working' } });

    const { spawnSpecGeneration } = await import('../spawner.js');
    const effectiveModel = (card.model || board?.default_model || 'opus') as string;

    // use --resume if the card has a session, otherwise fresh
    spawnSpecGeneration(card, dir, dbPath, {
      respecComment: prompt,
      boardId,
      model: effectiveModel,
      resumeSessionId: card.claude_session_id || undefined,
    });

    addNote(db, cardId, `Working on PR: ${prompt}`, 'user', 'note');
    return c.json({ success: true });
  });

  // ── Static files (React dashboard) ──
  // In dev (tsx): __dirname = src/server → ../web/dist = src/web/dist
  // In prod (tsc): __dirname = dist/server → fall back to src/web/dist
  const webDistPath = path.join(__dirname, '..', 'web', 'dist');
  const webDistAbsolute = fs.existsSync(webDistPath)
    ? webDistPath
    : path.join(__dirname, '..', '..', 'src', 'web', 'dist');

  app.get('/*', async (c) => {
    const reqPath = c.req.path;

    // Try to serve the requested static file
    const filePath = reqPath === '/' ? '/index.html' : reqPath;
    const fullPath = path.join(webDistAbsolute, filePath);

    try {
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const content = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.ico': 'image/x-icon',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.map': 'application/json',
        };
        c.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        return c.body(content);
      }
    } catch { /* file not found, fall through to SPA */ }

    // SPA fallback: serve index.html for all unmatched routes
    const indexPath = path.join(webDistAbsolute, 'index.html');
    if (fs.existsSync(indexPath)) {
      const content = fs.readFileSync(indexPath, 'utf-8');
      return c.html(content);
    }

    return c.text('Not found', 404);
  });

  // ── Pollers ──

  // Poll activity_log for changes from MCP processes, broadcast to SSE
  setInterval(() => {
    try {
      const rows = db.prepare('SELECT * FROM activity_log WHERE id > ? ORDER BY id ASC LIMIT 100')
        .all(lastActivityId) as any[];
      for (const row of rows) {
        lastActivityId = row.id;
        broadcastSSE({
          type: row.action,
          data: {
            card_id: row.card_id,
            actor: row.actor,
            details: row.details_json ? JSON.parse(row.details_json) : null,
            timestamp: row.created_at,
          },
        });
      }
    } catch (err) {
      console.error('[antfarm] Activity poll error:', err);
    }
  }, 1000);

  // Watchdog: release stale claimed cards after 30 minutes
  setInterval(() => {
    try {
      const released = releaseStaleCards(db, 30);
      for (const card of released) {
        broadcastSSE({ type: 'card.updated', data: { card_id: card.id, agent_status: 'idle', reason: 'lease_expired' } });
      }
    } catch (err) {
      console.error('[antfarm] Stale card watchdog error:', err);
    }
  }, 60_000);

  // Note: removed noisy unblocked-cards poller that re-emitted all unblocked
  // cards every 60s regardless of whether they were newly unblocked

  // ── Start ──
  // Clean up PTY sessions on process exit
  process.on('SIGTERM', () => { cleanupAllPtySessions(); process.exit(0); });
  process.on('SIGINT', () => { cleanupAllPtySessions(); process.exit(0); });

  return new Promise((resolve, reject) => {
    const tryPort = (p: number, attempts: number) => {
      if (attempts > 5) { reject(new Error('Could not find available port')); return; }
      const httpServer = serve({ fetch: app.fetch, port: p, hostname: '0.0.0.0' }, () => {
        console.log(`[antfarm] Dashboard running at http://0.0.0.0:${p}`);
        const row = db.prepare('SELECT MAX(id) as max_id FROM activity_log').get() as any;
        lastActivityId = row?.max_id ?? 0;

        // Attach WebSocket server for PTY sessions
        setupPtyWebSocket(httpServer as any);
        console.log(`[antfarm] WebSocket PTY server ready at ws://127.0.0.1:${p}/ws/pty/:cardId`);

        resolve(p);
      });

      // Handle EADDRINUSE by trying the next port
      (httpServer as any).on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`[antfarm] Port ${p} in use, trying ${p + 1}...`);
          tryPort(p + 1, attempts + 1);
        } else { reject(err); }
      });
    };
    tryPort(port, 0);
  });
}
