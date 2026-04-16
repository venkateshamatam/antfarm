# Antfarm

Agent coordination layer for Claude Code. A kanban board where Claude agents work through a pipeline: Idea -> Speccing -> Spec Ready -> Planning -> Plan Review -> Building -> Reviewing -> Done.

## Workflow Preferences

- **Always prefer gstack skills** over native Claude Code skills. Use `/plan-ceo-review`, `/plan-eng-review`, `/plan-design-review`, `/ship`, `/review`, `/qa`, `/browse`, `/investigate`, `/codex`, `/design-shotgun`, `/design-html`, `/simplify`, etc.
- **Run gstack skills without asking** — no need to confirm before invoking them.
- **Do NOT run `npx tsc --noEmit`** — this project doesn't use it for type checking (see dev notes below).

## What This Is

Antfarm spawns Claude Code CLI processes to generate specs, create implementation plans, build features, and review code. Each card on the board represents a task that moves through pipeline stages automatically. The dashboard (React + Vite) talks to a Hono API server backed by SQLite (better-sqlite3). An MCP server lets Claude Code sessions interact with the board programmatically.

## Architecture

```
CLI (src/cli.ts)
  |
  +-- Dashboard Server (src/server/index.ts) -- Hono on port 4800
  |     +-- REST API (/api/*)
  |     +-- SSE (/events)
  |     +-- WebSocket (/ws/pty/:cardId) -- live terminal streaming
  |
  +-- MCP Server (src/mcp/server.ts) -- stdio transport for Claude Code
  |
  +-- Spawner (src/spawner.ts) -- spawns `claude -p` CLI processes
  |     +-- spawnSpecGeneration -- generates product specs
  |     +-- spawnPlanner -- generates implementation plans (JSON)
  |     +-- spawnImplementation -- builds features in git worktrees
  |     +-- spawnCodexReview -- reviews code after build
  |
  +-- Agent Pool (src/pool.ts) -- per-board concurrency limiter (FIFO queue)
  |
  +-- SQLite DB (~/.antfarm/antfarm.db)
        +-- schema: src/db/schema.ts
        +-- queries: src/db/queries.ts
        +-- dependencies: src/db/deps.ts
```

## Project Structure

```
src/
  cli.ts                  -- entry point (antfarm, antfarm serve, antfarm mcp, antfarm setup)
  types.ts                -- shared types (Card, Board, Column, pipeline stages, etc.)
  pool.ts                 -- agent concurrency pool (per-board limits, FIFO queue, safety timeouts)
  spawner.ts              -- spawns claude CLI processes, parses stream-json output
  db/
    schema.ts             -- SQLite schema, migrations, WAL mode, default board seeding
    queries.ts            -- all DB operations (withRetry for SQLITE_BUSY)
    deps.ts               -- card dependency graph (cycle detection, blocker resolution)
  server/
    index.ts              -- Hono REST API, SSE broadcasting, pipeline action endpoints
    process-registry.ts   -- tracks spawned processes for live terminal streaming
    pty.ts                -- WebSocket terminal sessions (spawn shell or claude --resume)
  mcp/
    server.ts             -- MCP tools for Claude Code agents
    session.ts            -- unique session ID per MCP process
  web/                    -- React frontend (separate package.json, Vite)
    src/
      App.tsx             -- main app, board state, API calls, modals
      types.ts            -- frontend type mirrors (Card, Board, Column, etc.)
      components/
        Board.tsx          -- kanban columns with drag-and-drop (@dnd-kit)
        Card.tsx           -- card item with stage-specific actions and status badges
        CardDetail.tsx     -- modal with tabs: Spec (markdown), Notes, Subtasks
        CommandPalette.tsx -- Cmd+K search/create (cmdk)
        CreateTaskModal.tsx -- new task form with template type selector
        DirectoryModal.tsx -- project directory + concurrency settings
        ShortcutOverlay.tsx -- keyboard shortcut help (shadcn Dialog)
        Terminal.tsx       -- xterm.js terminal connected via WebSocket
        Chat.tsx           -- chat interface for sending messages to Claude sessions
        ModelSelect.tsx    -- model selection dropdown
      hooks/
        useSSE.ts          -- SSE connection with auto-reconnect, invalidates TanStack Query cache
        useKeyboardShortcuts.ts -- vim-style navigation (hjkl) and card actions
        useBoards.ts       -- TanStack Query hooks for all board/card CRUD operations
        useAvailableModels.ts -- fetches available Claude models
      api.ts               -- typed API client (all fetch calls centralized here)
      store.ts             -- Zustand global state store (replaces prop drilling)
      lib/
        utils.ts           -- cn() helper for Tailwind class merging (shadcn)
      components/ui/       -- shadcn/ui components (button, dialog, tabs, badge, etc.)
```

## Tech Stack

- **Backend**: Node.js, TypeScript, Hono, better-sqlite3, simple-git, ws
- **Frontend**: React 19, Vite, shadcn/ui, Tailwind CSS v4, TanStack Query v5, Zustand, @dnd-kit, xterm.js, cmdk, react-markdown
- **UI Framework**: shadcn/ui (Radix primitives + Tailwind) with Notion-inspired design tokens
- **State Management**: Zustand for UI state, TanStack Query for server state
- **Transport**: MCP over stdio, SSE for real-time updates, WebSocket for terminals
- **Database**: SQLite with WAL mode, stored at `~/.antfarm/antfarm.db`
- **Process spawning**: `claude -p <prompt> --output-format stream-json`

## Commands

```bash
# Development (API + Vite dev server with HMR)
npm run dev

# Build (compiles backend TS + Vite builds frontend)
npm run build

# Production
npm start

# Tests
npm test              # vitest watch mode
npm run test:run      # vitest single run
```

## Development Notes

### Do NOT run `npx tsc --noEmit`

The root tsconfig.json excludes `src/web/` and the web has its own tsconfig. Running tsc at the root is not the correct way to type-check this project. The frontend is checked by Vite's built-in TS support. The backend compiles via `npm run build`.

### Dev Server Ports

- API server: `http://127.0.0.1:4800`
- Vite dev server: `http://127.0.0.1:5173` (proxies `/api`, `/events`, `/ws` to 4800)
- In production, the API server serves the built frontend from `src/web/dist/`

### Database

SQLite at `~/.antfarm/antfarm.db`. Delete it to reset all data. Schema auto-migrates on startup (see `src/db/schema.ts`). All queries use parameterized statements. The `withRetry` wrapper in queries.ts handles SQLITE_BUSY with exponential backoff.

### Frontend Error Handling

API calls that check `!res.ok` must handle non-JSON error responses. Hono returns plain text "Internal Server Error" for unhandled exceptions. Use the `extractError` helper in App.tsx:

```typescript
async function extractError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data.error || fallback;
  } catch {
    return fallback;
  }
}
```

### Agent Pool

Each board has a configurable max concurrency (1-20, default 3). The pool in `src/pool.ts` queues requests FIFO when at capacity. A 35-minute safety timeout auto-releases slots if a process never completes. Pool status is broadcast via SSE.

### Pipeline Stages

Cards flow through: Idea -> Speccing -> Spec Ready -> Planning -> Plan Review -> Building -> Reviewing -> Done.

- **Idea**: User creates tasks. "Spec" button triggers spec generation.
- **Speccing**: Claude generates a product spec. Agent status = working.
- **Spec Ready**: User reviews spec. Can edit, re-spec with feedback, or approve.
- **Planning**: Claude generates a structured implementation plan (JSON).
- **Plan Review**: User reviews the plan. Can approve or reject with feedback (max 3 rejections).
- **Building**: Claude implements the spec in a git worktree branch.
- **Reviewing**: Auto-triggered code review after build completes.
- **Done**: Card completed. Shows worktree path and review summary.

### Git Worktrees

Implementation runs in isolated git worktrees under `<project>/.worktrees/`. Branch names are slugified from card titles (e.g., `feat/add-oauth-login`). Worktree creation is serialized with a mutex to prevent git lock contention. Chain cards share the same worktree so code changes accumulate across chain steps.

### Dark Mode

Uses `.dark` class on `<html>` (shadcn standard). Theme detection in `index.html` prevents flash. Store persists to `localStorage('antfarm-theme')`.

### CSS / Design System

shadcn/ui Nova preset with oklch color tokens. All colors go through shadcn's semantic variables (`--background`, `--foreground`, `--card`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`). App-specific tokens for pipeline stages (`--stage-*`), agent status (`--status-*`), and terminal (`--terminal-*`). Legacy component aliases map old `--bg-primary` / `--text-primary` vars to shadcn equivalents.

### Keyboard Shortcuts

- `j/k` or arrows: navigate cards within column
- `h/l` or left/right: navigate between columns
- `Enter`: open card detail
- `Escape`: close detail/clear selection
- `S`: generate spec
- `A`: approve
- `D`: delete
- `R`: retry errored card
- `Cmd+K`: command palette
- `?`: shortcut help overlay

### Remote Access (Tailscale + PWA)

Access Antfarm from your phone or any device:

1. Install Tailscale on your Mac: `brew install tailscale` (or download from tailscale.com)
2. Install Tailscale on your phone (iOS App Store / Google Play)
3. Sign in on both devices with the same account
4. Set an API key and start the server:
   ```bash
   ANTFARM_API_KEY=your-secret-here bun run start
   ```
5. Find your Mac's Tailscale hostname: `tailscale status` (looks like `your-mac.tail1234.ts.net`)
6. On your phone, open: `http://your-mac.tail1234.ts.net:4800/mobile`
7. Enter the API key when prompted
8. Tap "Share" > "Add to Home Screen" for the app-like experience

Notes:
- Desktop view: `http://...:4800/` (full kanban, terminal, drag-drop)
- Mobile view: `http://...:4800/mobile` (tap-optimized, stage tabs, quick actions)
- When `ANTFARM_API_KEY` is not set, no auth is required (localhost-only mode)
- The API key is sent as a Bearer token on every request
- SSE and WebSocket pass the token as a `?token=` query parameter

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming -> invoke office-hours
- Bugs, errors, "why is this broken", 500 errors -> invoke investigate
- Ship, deploy, push, create PR -> invoke ship
- QA, test the site, find bugs -> invoke qa
- Code review, check my diff -> invoke review
- Update docs after shipping -> invoke document-release
- Weekly retro -> invoke retro
- Design system, brand -> invoke design-consultation
- Visual audit, design polish -> invoke design-review
- Architecture review -> invoke plan-eng-review
- Save progress, checkpoint, resume -> invoke checkpoint
- Code quality, health check -> invoke health
