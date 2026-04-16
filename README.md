# antfarm

a kanban board where AI agents build your software. you describe what you want, agents spec it, plan it, build it, review it, and create the PR. you just approve at the gates.

built this because managing claude code agents in terminal windows doesn't scale. needed a visual pipeline where i could see what every agent is doing, approve specs before code gets written, and ship PRs without touching a terminal.

## how it works

```
you create a task
    → claude reads your codebase and writes a spec
        → you review and approve
            → claude creates an implementation plan
                → you review and approve
                    → claude builds it in an isolated git branch
                        → claude reviews its own code
                            → you create a PR
```

eight stages. idea → speccing → spec ready → planning → plan review → building → reviewing → done.

you control every gate. or turn on **auto-pilot** and it goes from idea to done without stopping.

## features

**the pipeline**
- 8-stage kanban: idea → speccing → spec ready → planning → plan review → building → reviewing → done
- every stage is automated. you just approve at the gates (or turn on auto-pilot and skip them all)
- real-time updates. cards move across the board as agents work. no refresh needed

**model selection**
- pick a model per task: opus for complex stuff, sonnet for standard work, haiku for quick fixes
- dynamically reads your claude account to show which models you actually have access to
- set a board-wide default, override per card

**task chains**
- link tasks into a sequence that shares one claude session
- task A finishes → task B auto-starts with full context of what A just built
- mix models per step. opus for the architecture, sonnet for the implementation
- drag to reorder. the execution order matters

**auto-pilot**
- toggle it on and the card goes from idea to done without stopping
- claude specs it, plans it, builds it, reviews it. zero human approval
- stops at Done. you review the code and create the PR when ready

**git and PRs**
- every build runs in an isolated git worktree. main stays clean
- create PRs from the board. pick your base branch, claude writes the title and description from the actual diff
- "work on PR" button: type what you want changed, claude resumes the same session, same branch

**mobile + remote**
- dedicated mobile view at `/mobile`, built for touch
- tailscale + API key auth. access from anywhere in the world
- create tasks, approve specs, check progress, create PRs from your phone

**everything else**
- live terminal: watch agents work in real-time in the browser
- vim-style keyboard shortcuts (hjkl to navigate, S to spec, A to approve)
- suggest tasks button: claude analyzes your codebase and suggests improvements

## prerequisites

- [bun](https://bun.sh) (runtime + package manager)
- [claude code](https://claude.ai/code) (the agents need this to run)
- a claude subscription (pro/max/team) for the models

## quick start

```bash
git clone https://github.com/venkateshamatam/antfarm.git
cd antfarm

# install dependencies (root + frontend)
bun install
cd src/web && bun install && cd ../..

# start the dashboard
bun run dev
```

open [http://localhost:5173](http://localhost:5173)

click the gear icon in the header → set your project directory to whatever codebase you want agents to work on. that's it. start creating tasks.

## run it on your phone

works from anywhere. your couch, a coffee shop, another country. your mac just needs to be awake.

**one-time setup:**

1. install [tailscale](https://tailscale.com) on your mac (`brew install tailscale && tailscale up`)
2. install tailscale on your phone (app store / play store), sign in with same account
3. find your mac's tailscale IP: `tailscale status`

**every time:**

```bash
ANTFARM_API_KEY=pick-any-secret bun run dev
```

on your phone, open `http://<your-tailscale-ip>:4800/mobile`, enter the API key, and tap "add to home screen" for the app experience.

the mobile view is purpose-built for touch. create tasks, approve specs, check progress, create PRs. same real-time updates as desktop.

## task chains

normally each task runs as its own claude session. the agent starts fresh every time.

with chains, you link tasks together. they run in the same session, in order:

```
task A (opus) → finishes building
    ↓ session carries over
task B (sonnet) → starts with full context of what A built
    ↓ session carries over  
task C (haiku) → starts with context of A + B
```

- each task still goes through the full pipeline (spec → plan → build → review)
- but when one finishes, the next auto-starts using `claude --resume`
- you can mix models per task in the chain
- drag to reorder in the chain tab

## auto-pilot

toggle auto-pilot on a task and it flows from idea to done without pausing for approval:

1. card created → spec generation starts immediately
2. spec done → planning starts immediately  
3. plan done → building starts immediately
4. build done → review starts immediately
5. review done → card lands in Done. stops here. you review and create the PR.

the agent pipeline runs fully autonomous. you just come back to a finished card with code ready to ship.

## project structure

```
src/
  cli.ts          — entry point
  spawner.ts      — spawns claude processes, handles --model and --resume
  pool.ts         — agent concurrency limiter (FIFO queue)
  types.ts        — shared types
  db/             — sqlite schema, queries, dependency graph
  server/         — hono API, SSE, websocket terminals
  mcp/            — MCP server for claude code integration
  web/            — react frontend (separate package.json)
    src/
      App.tsx           — desktop dashboard
      MobileApp.tsx     — mobile view
      components/       — board, cards, detail modal, terminal
      hooks/            — SSE, keyboard shortcuts, tanstack query
```

## license

MIT
