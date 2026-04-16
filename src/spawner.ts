// spawns claude code cli processes, captures session id and output,
// writes results back to sqlite. handles spec generation, planning,
// implementation, code review, and chain auto-advance.

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import simpleGit from 'simple-git';
import { initDatabase } from './db/schema.js';
import { updateSpec, addNote, addSubtask, createPlan, updatePlanStatus, getNextChainCard, getPreviousChainCard, getEffectiveModel, getCard } from './db/queries.js';
import { registerProcess } from './server/process-registry.js';
import { parseTemplateType, type SpecTemplateType, type ModelName } from './types.js';
import type { Card } from './types.js';
import { agentPool } from './pool.js';

// builds cli args for spawning claude. handles --model and --resume flags.
function buildClaudeArgs(prompt: string, opts?: { model?: ModelName; resumeSessionId?: string }): string[] {
  const args: string[] = [];
  if (opts?.resumeSessionId) args.push('--resume', opts.resumeSessionId);
  if (opts?.model) args.push('--model', opts.model);
  args.push('-p', prompt, '--output-format', 'stream-json');
  return args;
}

// parses stream-json output from claude cli into session id, result text, and usage stats.
export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
}

function parseStreamJsonOutput(stdout: string): { sessionId: string | null; resultText: string; usage: SessionUsage | null } {
  let sessionId: string | null = null;
  let resultText = '';
  let usage: SessionUsage | null = null;

  const trimmed = stdout.trim();
  let items: any[] = [];

  if (trimmed.startsWith('[')) {
    try { items = JSON.parse(trimmed); } catch { /* fall through */ }
  }
  if (items.length === 0) {
    for (const line of trimmed.split('\n')) {
      try { items.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }

  for (const parsed of items) {
    if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
      sessionId = parsed.session_id;
    }
    if (parsed.type === 'result') {
      if (parsed.result) resultText = parsed.result;
      // Extract usage stats from the result message
      if (parsed.usage || parsed.total_cost_usd != null) {
        usage = {
          input_tokens: parsed.usage?.input_tokens ?? 0,
          output_tokens: parsed.usage?.output_tokens ?? 0,
          total_cost_usd: parsed.total_cost_usd ?? 0,
          duration_ms: parsed.duration_ms ?? 0,
          num_turns: parsed.num_turns ?? 0,
        };
      }
    }
    if (parsed.type === 'assistant' && parsed.message?.content) {
      const tc = parsed.message.content.find((c: any) => c.type === 'text');
      if (tc?.text) resultText = tc.text;
    }
  }

  if (!resultText) resultText = trimmed;
  return { sessionId, resultText, usage };
}

// options for spawn functions
export interface SpawnOptions {
  respecComment?: string;
  boardId?: number;
  resumeSessionId?: string;
  model?: ModelName;
}

// creates a one-shot release callback for the agent pool slot
function makeReleaser(boardId: number | undefined, cardId: number): () => void {
  let released = false;
  return () => {
    if (!released && boardId != null) {
      released = true;
      agentPool.release(boardId, cardId);
    }
  };
}

// Converts a card title into a valid git branch name with feat/ prefix.
// Lowercases, replaces non-alphanumeric chars with hyphens, deduplicates
// hyphens, trims, and truncates to 60 chars.
export function slugifyBranch(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `feat/${slug || 'task'}`;
}

// Mutex to serialize git worktree operations and prevent lock contention
let worktreeLock: Promise<void> = Promise.resolve();

// Creates a git worktree branch for the card. Returns the branch name and
// worktree path. Handles duplicate branch names by appending the card ID,
// and reuses existing worktrees on rebuild.
async function createWorktree(
  card: Card,
  projectDir: string
): Promise<{ branchName: string; worktreePath: string }> {
  // Serialize worktree operations to prevent git lock contention
  const result = new Promise<{ branchName: string; worktreePath: string }>((resolve, reject) => {
    worktreeLock = worktreeLock.then(async () => {
      try {
        const r = await createWorktreeInner(card, projectDir);
        resolve(r);
      } catch (err) {
        reject(err);
      }
    });
  });
  return result;
}

async function createWorktreeInner(
  card: Card,
  projectDir: string
): Promise<{ branchName: string; worktreePath: string }> {
  const git = simpleGit(projectDir);

  let branchName = slugifyBranch(card.title);

  // If slug produced generic fallback and title was all special chars, use card ID
  if (branchName === 'feat/task' && card.title.replace(/[^a-z0-9]/gi, '').length === 0) {
    branchName = `feat/task-${card.id}`;
  }

  const worktreeDir = path.join(projectDir, '.worktrees');
  let worktreePath = path.join(worktreeDir, branchName.replace(/\//g, '-'));

  // If worktree already exists (rebuild scenario), reuse it
  if (fs.existsSync(worktreePath)) {
    return { branchName, worktreePath };
  }

  // Check if branch already exists (possible duplicate title)
  let branchExists = false;
  try {
    await git.raw(['rev-parse', '--verify', branchName]);
    branchExists = true;
  } catch {
    // Branch doesn't exist
  }

  if (branchExists) {
    // Append card ID suffix for uniqueness
    const uniqueBranch = `${branchName}-${card.id}`;
    const uniqueWorktreePath = path.join(worktreeDir, uniqueBranch.replace(/\//g, '-'));

    if (fs.existsSync(uniqueWorktreePath)) {
      return { branchName: uniqueBranch, worktreePath: uniqueWorktreePath };
    }

    branchName = uniqueBranch;
    worktreePath = uniqueWorktreePath;
  }

  // Ensure .worktrees directory exists
  fs.mkdirSync(worktreeDir, { recursive: true });

  // Create the worktree with a new branch from HEAD
  await git.raw(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);

  return { branchName, worktreePath };
}

// Returns additional prompt sections based on the spec template type
function getTemplatePromptSections(templateType: SpecTemplateType): string {
  switch (templateType) {
    case 'api_endpoint':
      return [
        ``,
        `### 7. API Contract`,
        `Define the complete API contract:`,
        `- HTTP method and path (e.g., GET /api/v1/resource)`,
        `- Query parameters (name, type, required/optional, default)`,
        `- Request body schema (JSON with types, validation rules)`,
        `- Response schema for success (JSON with types)`,
        `- Status codes and error response shapes (400, 401, 403, 404, 409, 422, 500)`,
        `- Content-Type and Accept headers`,
        ``,
        `### 8. Auth & Rate Limiting`,
        `- Authentication method (API key, JWT, session cookie, etc.)`,
        `- Authorization rules (who can call this endpoint, role checks)`,
        `- Rate limiting strategy (requests per minute, per user vs global)`,
        `- Pagination approach if returning lists (cursor vs offset, page size, max)`,
        ``,
        `### 9. Example Requests`,
        `Include example curl commands in the Validation section for:`,
        `- Successful request with expected response`,
        `- Request with missing required fields`,
        `- Request with invalid authentication`,
      ].join('\n');

    case 'ui_component':
      return [
        ``,
        `### 7. Component API`,
        `Define the component's public interface:`,
        `- Props interface with TypeScript types and defaults`,
        `- Required vs optional props`,
        `- Callback prop signatures (e.g., onChange, onSubmit)`,
        `- Children/slot patterns if applicable`,
        ``,
        `### 8. State & Data Flow`,
        `- Local state (useState) vs lifted state vs global store`,
        `- Data fetching approach (server component, useEffect, SWR/React Query)`,
        `- Optimistic updates if applicable`,
        ``,
        `### 9. Accessibility & Responsiveness`,
        `- ARIA roles and attributes`,
        `- Keyboard navigation (Tab order, Enter/Space activation, Escape to close)`,
        `- Screen reader announcements for dynamic content`,
        `- Focus management (initial focus, focus trap for modals)`,
        `- Responsive behavior at breakpoints (mobile, tablet, desktop)`,
        ``,
        `### 10. Component States`,
        `- Loading state (skeleton, spinner, placeholder)`,
        `- Empty state (no data, first-time user)`,
        `- Error state (failed fetch, validation errors)`,
        `- Disabled state`,
        `- Hover/active/focus visual states`,
      ].join('\n');

    case 'refactor':
      return [
        ``,
        `### 7. Current State Analysis`,
        `- What exists today and where (file paths, function names)`,
        `- Why it's problematic (complexity, performance, maintainability, bugs)`,
        `- Metrics if available (lines of code, cyclomatic complexity, test coverage)`,
        ``,
        `### 8. Target State`,
        `- What it should look like after the refactor`,
        `- New file/module structure`,
        `- Before/after code comparison for key changes`,
        ``,
        `### 9. Migration Strategy`,
        `- Can this be done incrementally or must it be atomic?`,
        `- If incremental: what are the safe intermediate states?`,
        `- Feature flags or compatibility shims needed during migration`,
        `- Data migration steps if schema changes are involved`,
        ``,
        `### 10. Risk Assessment`,
        `- What could break (list specific features, flows, integrations)`,
        `- What tests currently cover the affected code paths`,
        `- New tests needed to ensure correctness after refactor`,
        `- Rollback plan if something goes wrong`,
      ].join('\n');

    case 'bugfix':
      return [
        ``,
        `### 7. Reproduction Steps`,
        `- Exact steps to trigger the bug (numbered, specific)`,
        `- Environment details (browser, OS, config) if relevant`,
        `- Frequency (always, intermittent, specific conditions)`,
        `- Screenshots or error messages if available`,
        ``,
        `### 8. Expected vs Actual Behavior`,
        `- What should happen (the correct behavior)`,
        `- What actually happens (the bug)`,
        `- When this started (if known — commit, deploy, date)`,
        ``,
        `### 9. Root Cause Analysis`,
        `- Why does the bug exist (not just where, but why)`,
        `- The specific code path that leads to the incorrect behavior`,
        `- Why existing tests didn't catch it`,
        ``,
        `### 10. Regression Prevention`,
        `- What other code touches the same code path (blast radius)`,
        `- Specific regression test to add (describe the test case)`,
        `- Related areas to manually verify after the fix`,
      ].join('\n');

    case 'general':
    default:
      return '';
  }
}

// Spawns Claude Code to generate a product spec for a card.
// Captures the session ID and spec output, writes both back to the card.
// If respecComment is provided, includes the previous spec and user feedback.
export function spawnSpecGeneration(card: Card, projectDir: string, dbPath: string, opts?: SpawnOptions): { pid: number } {
  const { respecComment, boardId, resumeSessionId, model } = opts ?? {};
  const isRespec = !!card.spec && !!respecComment;
  const templateType = parseTemplateType(card.context);
  const templateSections = getTemplatePromptSections(templateType);

  const specStructure = [
    `## Required Spec Sections`,
    ``,
    `### 1. Summary`,
    `One paragraph. What this feature does, who it's for, and why it matters.`,
    ``,
    `### 2. Requirements`,
    `Bulleted list. Each requirement is specific and testable. No vague words like "handle" or "manage" — say exactly what happens.`,
    ``,
    `### 3. Technical Approach`,
    `How to build it. Reference actual files, functions, and patterns in the codebase.`,
    `For each new component: name it, say where it lives, what it does, and what it connects to.`,
    `Include:`,
    `- New files/routes/components to create (with paths)`,
    `- Existing code to modify (with paths)`,
    `- Data model changes (new tables, columns, or fields)`,
    `- API contract for any new endpoints (method, path, request/response shape)`,
    ``,
    `### 4. Edge Cases`,
    `What breaks? For every new data flow, consider:`,
    `- Nil/missing input`,
    `- Empty input (zero-length, blank string)`,
    `- Upstream failure (API timeout, DB error)`,
    `- Concurrent access / race conditions`,
    `- User does something unexpected (double-click, navigate away, stale state)`,
    `Name each edge case specifically and say how to handle it.`,
    ``,
    `### 5. Implementation Checklist`,
    `Ordered list of concrete tasks. Each item:`,
    `- Starts with a verb`,
    `- Names the specific file or function`,
    `- Is ordered so dependencies come before dependents`,
    `Use "- [ ] " checkbox format.`,
    ``,
    `### 6. Validation`,
    `How do you know it works? Table or list of: what to check, how to check it, what "pass" looks like.`,
  ].join('\n') + templateSections;

  const promptParts = isRespec
    ? [
        `Revise the product specification based on user feedback.`,
        `Read the project's CLAUDE.md files and codebase structure first to ground your spec in reality.`,
        ``,
        `Task: ${card.title}`,
        card.description ? `Description: ${card.description}` : '',
        card.context ? `Additional context: ${card.context}` : '',
        ``,
        `Previous spec:`,
        card.spec,
        ``,
        `User feedback: ${respecComment}`,
        ``,
        specStructure,
        ``,
        `Output the complete revised spec in markdown. No preamble, no explanation — just the spec.`,
      ]
    : [
        `You are a senior product engineer writing a spec that a coding agent will implement with zero clarifying questions.`,
        ``,
        `First: read all CLAUDE.md files in this project to understand the codebase, patterns, and conventions.`,
        `Then: generate a detailed, implementation-ready product specification.`,
        ``,
        `Task: ${card.title}`,
        card.description ? `Description: ${card.description}` : '',
        card.context ? `Additional context: ${card.context}` : '',
        ``,
        specStructure,
        ``,
        `Rules:`,
        `- Be specific. Reference actual file paths, function names, table names from this codebase.`,
        `- No vague language. Every requirement must be concrete enough to verify.`,
        `- The implementation checklist should be detailed enough that a junior developer could follow it.`,
        `- Think about error states and edge cases seriously — these catch real bugs.`,
        `- If something is ambiguous in the task description, make a reasonable decision and state the assumption.`,
        ``,
        `Output ONLY the spec in markdown. No preamble, no meta-commentary — just the spec.`,
      ];
  const prompt = promptParts.filter(Boolean).join('\n');

  const child = spawn('claude', buildClaudeArgs(prompt, { model, resumeSessionId }), {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env },
  });

  registerProcess(card.id, child, 'spec');

  let stdout = '';
  let stderr = '';
  const releaseSlot = makeReleaser(boardId, card.id);

  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  child.on('error', () => { releaseSlot(); });

  child.on('close', (code) => {
    releaseSlot();
    const db = initDatabase(dbPath);
    try {
      if (code === 0 && stdout.trim()) {
        const { sessionId, resultText: specText, usage } = parseStreamJsonOutput(stdout);
        if (usage) {
          addNote(db, card.id, JSON.stringify(usage), 'agent', 'output');
        }

        if (sessionId) {
          db.prepare("UPDATE cards SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?")
            .run(sessionId, card.id);
        }

        // Write the spec to the card
        updateSpec(db, card.id, specText);

        // Extract checklist items from spec and create subtasks
        const checklistPattern = /^-\s*\[[ x]\]\s*(.+)$/gm;
        let match;
        while ((match = checklistPattern.exec(specText)) !== null) {
          const text = match[1].trim();
          if (text) addSubtask(db, card.id, text);
        }

        addNote(db, card.id, 'Spec generated successfully', 'agent', 'status_change');
      } else {
        const errorMsg = stderr.trim() || `Claude Code exited with code ${code}`;
        addNote(db, card.id, `Spec generation failed: ${errorMsg}`, 'agent', 'status_change');

        // Move card back to Idea column with error status
        const ideaCol = db.prepare(
          "SELECT id FROM columns WHERE board_id = (SELECT board_id FROM columns WHERE id = ?) AND name = 'Idea' LIMIT 1"
        ).get(card.column_id) as { id: number } | undefined;

        if (ideaCol) {
          db.prepare(
            "UPDATE cards SET column_id = ?, agent_status = 'errored', spec_status = 'pending', updated_at = datetime('now') WHERE id = ?"
          ).run(ideaCol.id, card.id);
        } else {
          db.prepare(
            "UPDATE cards SET agent_status = 'errored', spec_status = 'pending', updated_at = datetime('now') WHERE id = ?"
          ).run(card.id);
        }

        db.prepare(
          "INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, 'card.spec_failed', 'agent', ?)"
        ).run(card.id, JSON.stringify({ error: errorMsg }));
      }
    } finally {
      db.close();
    }
  });

  child.unref();
  return { pid: child.pid ?? 0 };
}

// Spawns a lightweight Claude session to generate a structured implementation plan.
// Does NOT write code — only produces a JSON plan with files, steps, and scope.
// If rejectionFeedback is provided, it includes the previous plan and feedback for re-planning.
export function spawnPlanner(card: Card, projectDir: string, dbPath: string, opts?: { rejectionFeedback?: string; model?: ModelName; resumeSessionId?: string }): { pid: number } {
  const { rejectionFeedback, model, resumeSessionId } = opts ?? {};
  const previousPlan = !!rejectionFeedback;

  const planSchema = JSON.stringify({
    files_to_create: [{ path: 'string', purpose: 'string' }],
    files_to_modify: [{ path: 'string', changes: 'string' }],
    steps: [{ order: 'number', description: 'string', files: ['string'] }],
    estimated_scope: 'small | medium | large',
    dependencies: ['string'],
  }, null, 2);

  const promptParts = [
    `You are a technical planner. Given the following specification, produce a structured implementation plan.`,
    `Do NOT write any code. Do NOT create or modify any files. Output ONLY valid JSON matching the schema below.`,
    ``,
    `## Task: ${card.title}`,
    card.description ? `## Description: ${card.description}` : '',
    ``,
    `## Approved Specification:`,
    card.spec ?? 'No spec provided.',
    ``,
    ...(previousPlan && rejectionFeedback ? [
      `## Previous plan was rejected with this feedback:`,
      rejectionFeedback,
      ``,
      `Incorporate the feedback and produce an improved plan.`,
      ``,
    ] : []),
    `## Output Schema (JSON only):`,
    '```json',
    planSchema,
    '```',
    ``,
    `## Guidelines:`,
    `- files_to_create: New files with their path relative to project root and purpose`,
    `- files_to_modify: Existing files that need changes, with description of what changes`,
    `- steps: Ordered implementation steps, each referencing which files are involved`,
    `- estimated_scope: "small" (<3 files), "medium" (3-8 files), "large" (8+ files)`,
    `- dependencies: External packages, services, or prerequisites needed`,
    `- Reference actual file paths from the codebase`,
    `- Order steps so dependencies come before dependents`,
    ``,
    `Output ONLY the JSON object. No markdown fences, no explanation, no preamble.`,
  ];
  const prompt = promptParts.filter(Boolean).join('\n');

  const child = spawn('claude', buildClaudeArgs(prompt, { model, resumeSessionId }), {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env },
  });

  registerProcess(card.id, child, 'plan');

  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  child.on('close', (code) => {
    const db = initDatabase(dbPath);
    try {
      const { sessionId, resultText, usage } = parseStreamJsonOutput(stdout);
      if (usage) addNote(db, card.id, JSON.stringify(usage), 'agent', 'output');

      if (sessionId) {
        db.prepare("UPDATE cards SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(sessionId, card.id);
      }

      if (code === 0 && resultText) {
        // Try to parse the JSON plan from the output
        let planData: any = null;
        try {
          // Strip markdown fences if present
          let jsonStr = resultText.trim();
          if (jsonStr.startsWith('```')) {
            jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
          }
          planData = JSON.parse(jsonStr);
        } catch {
          // Try to find JSON object in the output
          const jsonMatch = resultText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try { planData = JSON.parse(jsonMatch[0]); } catch {}
          }
        }

        if (planData && planData.steps) {
          // Store the structured plan
          createPlan(db, card.id, {
            files_to_create: planData.files_to_create || [],
            files_to_modify: planData.files_to_modify || [],
            steps: planData.steps || [],
            estimated_scope: ['small', 'medium', 'large'].includes(planData.estimated_scope) ? planData.estimated_scope : 'medium',
            dependencies: planData.dependencies || [],
          });

          // Move to Plan Review column
          updatePlanStatus(db, card.id, 'ready');

          const planReviewCol = db.prepare(
            "SELECT id FROM columns WHERE board_id = (SELECT board_id FROM columns WHERE id = ?) AND name = 'Plan Review' LIMIT 1"
          ).get(card.column_id) as { id: number } | undefined;

          if (planReviewCol) {
            db.prepare(
              "UPDATE cards SET column_id = ?, agent_status = 'idle', updated_at = datetime('now') WHERE id = ?"
            ).run(planReviewCol.id, card.id);
          }

          addNote(db, card.id, 'Implementation plan generated successfully', 'agent', 'status_change');
          db.prepare(
            "INSERT INTO activity_log (card_id, action, actor) VALUES (?, 'card.plan_ready', 'agent')"
          ).run(card.id);
        } else {
          // Plan parsing failed
          updatePlanStatus(db, card.id, 'failed');
          db.prepare(
            "UPDATE cards SET agent_status = 'errored', updated_at = datetime('now') WHERE id = ?"
          ).run(card.id);
          addNote(db, card.id, `Plan generation failed: Could not parse plan output.\n\nRaw output:\n${resultText.slice(0, 500)}`, 'agent', 'status_change');
          db.prepare(
            "INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, 'card.plan_failed', 'agent', ?)"
          ).run(card.id, JSON.stringify({ error: 'parse_failed' }));
        }
      } else {
        const errorMsg = stderr.trim() || `Claude Code exited with code ${code}`;
        updatePlanStatus(db, card.id, 'failed');
        db.prepare(
          "UPDATE cards SET agent_status = 'errored', updated_at = datetime('now') WHERE id = ?"
        ).run(card.id);
        addNote(db, card.id, `Plan generation failed: ${errorMsg}`, 'agent', 'status_change');
        db.prepare(
          "INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, 'card.plan_failed', 'agent', ?)"
        ).run(card.id, JSON.stringify({ error: errorMsg }));
      }
    } finally {
      db.close();
    }
  });

  child.unref();
  return { pid: child.pid ?? 0 };
}

// Spawns Claude Code to implement an approved spec.
// Creates a git worktree branch before spawning so the agent works in isolation.
export async function spawnImplementation(card: Card, projectDir: string, dbPath: string, opts?: SpawnOptions): Promise<{ pid: number }> {
  const { boardId, resumeSessionId, model } = opts ?? {};
  // Create or reuse a worktree for isolated implementation
  let worktreePath = projectDir;
  let branchName: string | null = null;

  try {
    // If this card is in a chain, try to reuse the previous card's worktree
    // so code changes accumulate across chain steps
    let reusingChainWorktree = false;
    if (card.chain_id != null && card.chain_position != null && card.chain_position > 0) {
      const db = initDatabase(dbPath);
      try {
        const prevCard = getPreviousChainCard(db, card.chain_id, card.chain_position);
        if (prevCard?.worktree_path && fs.existsSync(prevCard.worktree_path)) {
          worktreePath = prevCard.worktree_path;
          branchName = prevCard.git_branch ?? null;
          reusingChainWorktree = true;
          addNote(db, card.id, `Reusing worktree from chain card #${prevCard.id}: ${worktreePath}`, 'agent', 'status_change');
          db.prepare(
            "UPDATE cards SET git_branch = ?, worktree_path = ?, updated_at = datetime('now') WHERE id = ?"
          ).run(branchName, worktreePath, card.id);
        }
      } finally {
        db.close();
      }
    }

    // If not reusing a chain worktree, create a new one
    if (!reusingChainWorktree) {
      const wt = await createWorktree(card, projectDir);
      worktreePath = wt.worktreePath;
      branchName = wt.branchName;

      const db = initDatabase(dbPath);
      try {
        db.prepare(
          "UPDATE cards SET git_branch = ?, worktree_path = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(branchName, worktreePath, card.id);
      } finally {
        db.close();
      }
    }
  } catch (err) {
    // If worktree creation fails, fall back to main project dir and log the error
    const db = initDatabase(dbPath);
    try {
      addNote(db, card.id, `Worktree creation failed, building in main directory: ${err}`, 'agent', 'status_change');
    } finally {
      db.close();
    }
  }

  const prompt = [
    `Implement the following feature based on this approved product spec.`,
    ``,
    `Task: ${card.title}`,
    ``,
    `Spec:`,
    card.spec ?? 'No spec provided.',
    ``,
    `Instructions:`,
    `1. Implement the spec fully.`,
    `2. Write tests if appropriate.`,
    `3. Do NOT commit, push, or create PRs.`,
    `4. Summarize what you built and what files you changed.`,
  ].join('\n');

  const child = spawn('claude', buildClaudeArgs(prompt, { model, resumeSessionId }), {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env },
  });

  registerProcess(card.id, child, 'build');

  let stdout = '';
  let stderr = '';
  const releaseImplSlot = makeReleaser(boardId, card.id);

  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  child.on('error', () => { releaseImplSlot(); });

  // Capture worktreePath in closure for the review step
  const buildWorktreePath = worktreePath;

  child.on('close', (code) => {
    // Release the pool slot BEFORE chaining spawnCodexReview to avoid deadlock on 1-slot pools
    releaseImplSlot();

    const db = initDatabase(dbPath);
    try {
      const { sessionId, resultText, usage } = parseStreamJsonOutput(stdout);
      if (usage) addNote(db, card.id, JSON.stringify(usage), 'agent', 'output');

      if (sessionId) {
        db.prepare("UPDATE cards SET claude_session_id = ?, updated_at = datetime('now') WHERE id = ?")
          .run(sessionId, card.id);
      }

      if (code === 0) {
        addNote(db, card.id, resultText || 'Implementation completed', 'agent', 'status_change');

        // Move to Reviewing column for codex review step
        const reviewCol = db.prepare(
          "SELECT id FROM columns WHERE board_id = (SELECT board_id FROM columns WHERE id = ?) AND name = 'Reviewing' LIMIT 1"
        ).get(card.column_id) as { id: number } | undefined;

        if (reviewCol) {
          db.prepare(
            "UPDATE cards SET column_id = ?, agent_status = 'idle', updated_at = datetime('now') WHERE id = ?"
          ).run(reviewCol.id, card.id);
        }

        db.prepare(
          "INSERT INTO activity_log (card_id, action, actor) VALUES (?, 'card.build_complete', 'agent')"
        ).run(card.id);

        // Auto-trigger codex review in the same worktree (slot already released above)
        try {
          spawnCodexReview(card, buildWorktreePath, dbPath, { boardId, model });
        } catch { /* non-critical if review fails to start */ }
      } else {
        const errorMsg = stderr.trim() || `Claude Code exited with code ${code}`;
        addNote(db, card.id, `Implementation failed: ${errorMsg}`, 'agent', 'status_change');
        db.prepare(
          "UPDATE cards SET agent_status = 'errored', updated_at = datetime('now') WHERE id = ?"
        ).run(card.id);
      }
    } finally {
      db.close();
    }
  });

  child.unref();
  return { pid: child.pid ?? 0 };
}

// Spawns a code review on the changes made during building.
// Tries codex first, falls back to Claude subagent review.
export function spawnCodexReview(card: Card, projectDir: string, dbPath: string, opts?: SpawnOptions): { pid: number } {
  const { boardId, model } = opts ?? {};

  const prompt = [
    `Review the uncommitted changes in this directory.`,
    ``,
    `Task that was implemented: ${card.title}`,
    ``,
    `Instructions:`,
    `1. Look at all uncommitted changes (git diff, git status).`,
    `2. Review for bugs, security issues, code quality problems.`,
    `3. Fix any issues you find directly in the code.`,
    `4. Do NOT commit. Do NOT push. Do NOT create PRs.`,
    `5. Output a summary with three sections:`,
    `   - CHANGES BUILT: What was implemented (files changed, features added)`,
    `   - REVIEW FINDINGS: What issues were found and fixed`,
    `   - WORKTREE: The current working directory path`,
  ].join('\n');

  const child = spawn('claude', buildClaudeArgs(prompt, { model }), {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env },
  });

  registerProcess(card.id, child, 'build');

  let stdout = '';
  let stderr = '';
  const releaseReviewSlot = makeReleaser(boardId, card.id);

  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

  child.on('error', () => { releaseReviewSlot(); });

  child.on('close', (code) => {
    releaseReviewSlot();
    const db = initDatabase(dbPath);
    try {
      const { resultText, usage } = parseStreamJsonOutput(stdout);
      if (usage) addNote(db, card.id, JSON.stringify(usage), 'agent', 'output');

      const summary = code === 0
        ? `Code review completed:\n\n${resultText}\n\nWorktree: ${projectDir}`
        : `Code review failed: ${stderr.trim() || `exit code ${code}`}`;

      addNote(db, card.id, summary, 'agent', 'status_change');

      // Move to Done
      const doneCol = db.prepare(
        "SELECT id FROM columns WHERE board_id = (SELECT board_id FROM columns WHERE id = ?) AND name = 'Done' LIMIT 1"
      ).get(card.column_id) as { id: number } | undefined;

      if (doneCol) {
        db.prepare(
          "UPDATE cards SET column_id = ?, agent_status = 'completed', updated_at = datetime('now') WHERE id = ?"
        ).run(doneCol.id, card.id);
      }

      db.prepare(
        "INSERT INTO activity_log (card_id, action, actor) VALUES (?, 'card.review_complete', 'agent')"
      ).run(card.id);

      // ── Auto-advance chain ──
      // If this card is in a chain and just completed, trigger the next card
      try {
        const completedCard = getCard(db, card.id);
        if (completedCard?.chain_id != null && completedCard.chain_position != null) {
          const nextCard = getNextChainCard(db, completedCard.chain_id, completedCard.chain_position);
          if (nextCard && nextCard.agent_status !== 'working' && nextCard.agent_status !== 'waiting') {
              const col = db.prepare('SELECT board_id FROM columns WHERE id = ?').get(nextCard.column_id) as { board_id: number } | undefined;
              const nextBoardId = col?.board_id;
              const board = nextBoardId ? db.prepare('SELECT * FROM boards WHERE id = ?').get(nextBoardId) as any : null;

              if (board?.directory) {
                const nextModel = getEffectiveModel(db, nextCard.id);
                const resumeId = completedCard.claude_session_id || undefined;

                // Determine what to trigger based on next card's state
                if (!nextCard.spec || nextCard.spec_status === 'pending') {
                  // Auto-trigger spec generation
                  addNote(db, nextCard.id, `Chain auto-advance: starting spec (resumed from card #${completedCard.id})`, 'agent', 'status_change');

                  const speccingCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Speccing'").get(board.id) as any;
                  if (speccingCol) {
                    db.prepare("UPDATE cards SET column_id = ?, spec_status = 'generating', agent_status = 'working', updated_at = datetime('now') WHERE id = ?")
                      .run(speccingCol.id, nextCard.id);
                  }

                  spawnSpecGeneration(nextCard, board.directory, dbPath, {
                    boardId: nextBoardId,
                    model: nextModel,
                    resumeSessionId: resumeId,
                  });
                } else if (nextCard.spec_status === 'approved' && nextCard.plan_status === 'approved') {
                  // Spec and plan approved — auto-trigger build
                  addNote(db, nextCard.id, `Chain auto-advance: starting build (resumed from card #${completedCard.id})`, 'agent', 'status_change');

                  const buildingCol = db.prepare("SELECT id FROM columns WHERE board_id = ? AND name = 'Building'").get(board.id) as any;
                  if (buildingCol) {
                    db.prepare("UPDATE cards SET column_id = ?, agent_status = 'working', updated_at = datetime('now') WHERE id = ?")
                      .run(buildingCol.id, nextCard.id);
                  }

                  spawnImplementation(nextCard, board.directory, dbPath, {
                    boardId: nextBoardId,
                    model: nextModel,
                    resumeSessionId: resumeId,
                  });
                }
                // else: spec exists but not approved — wait for human approval (chain pauses)
              }
          }
          // No next card = chain complete (last card finished)
        }
      } catch { /* auto-advance is non-critical — don't break the review completion */ }
    } finally {
      db.close();
    }
  });

  child.unref();
  return { pid: child.pid ?? 0 };
}
