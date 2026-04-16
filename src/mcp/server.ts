// MCP Server for Antfarm — exposes tools for Claude Code agents to
// interact with the task pipeline. Each Claude Code session spawns
// this as a separate process via stdio transport.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getSessionId } from './session.js';
import { initDatabase } from '../db/schema.js';
import {
  getBoards,
  getBoardWithColumns,
  getAllBoardCards,
  getCard,
  createCard,
  updateCard,
  updateSpec,
  setPr,
  addNote,
  addSubtask,
  completeSubtask,
  getSubtasks,
  getNotes,
  getProjectContext,
  touchCard,
  getNextAvailableCard,
} from '../db/queries.js';

const DB_PATH = process.env.ANTFARM_DB_PATH || `${process.env.HOME}/.antfarm/antfarm.db`;

export async function startMcpServer() {
  const db = initDatabase(DB_PATH);
  const sessionId = getSessionId();

  const server = new McpServer({ name: 'antfarm', version: '0.2.0' });

  // Returns this MCP session's unique ID
  server.tool('antfarm_whoami', {}, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ success: true, data: { session_id: sessionId } }) }],
  }));

  // Get the full board with columns and cards
  server.tool('antfarm_get_board', {
    board_id: z.number().optional().describe('Board ID. Omit for default board.'),
  }, async ({ board_id }) => {
    const boards = getBoards(db);
    const targetId = board_id ?? boards[0]?.id;
    if (!targetId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No boards exist' }) }] };
    const result = getBoardWithColumns(db, targetId);
    if (!result) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Board not found' }) }] };
    const cards = getAllBoardCards(db, targetId);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { ...result, cards } }) }] };
  });

  // Get full card detail
  server.tool('antfarm_get_card', {
    card_id: z.number().describe('Card ID'),
  }, async ({ card_id }) => {
    const card = getCard(db, card_id);
    if (!card) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Card not found' }) }] };
    const subtasks = getSubtasks(db, card_id);
    const notes = getNotes(db, card_id);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { ...card, subtasks, notes } }) }] };
  });

  // Create a new task card
  server.tool('antfarm_create_card', {
    title: z.string().max(200).describe('Card title'),
    description: z.string().optional().describe('Card description (2-3 sentences)'),
    column_id: z.number().optional().describe('Column ID. Omit for Idea column.'),
  }, async (params) => {
    let columnId = params.column_id;
    if (!columnId) {
      const boards = getBoards(db);
      if (!boards.length) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No boards' }) }] };
      const result = getBoardWithColumns(db, boards[0].id);
      columnId = result?.columns[0]?.id;
    }
    if (!columnId) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No columns' }) }] };
    try {
      const card = createCard(db, { column_id: columnId, title: params.title, description: params.description });
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: card }) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }] };
    }
  });

  // Write a generated spec to a card
  server.tool('antfarm_update_spec', {
    card_id: z.number().describe('Card ID'),
    spec: z.string().describe('The generated product specification (markdown)'),
  }, async ({ card_id, spec }) => {
    const card = updateSpec(db, card_id, spec);
    if (!card) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Card not found' }) }] };
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: card }) }] };
  });

  // Update card pipeline status (moves card through columns)
  server.tool('antfarm_update_status', {
    card_id: z.number(),
    status: z.string().describe('Pipeline status: spec_ready, approved, building, pr_ready, done'),
  }, async ({ card_id, status }) => {
    // Map status to column name and update
    const statusToColumn: Record<string, string> = {
      spec_ready: 'Spec Ready',
      approved: 'Approved',
      building: 'Building',
      pr_ready: 'Done',
      done: 'Done',
    };
    const colName = statusToColumn[status];
    if (!colName) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Unknown status: ${status}` }) }] };

    const card = getCard(db, card_id);
    if (!card) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Card not found' }) }] };

    const col = db.prepare(
      "SELECT id FROM columns WHERE board_id = (SELECT board_id FROM columns WHERE id = ?) AND name = ? LIMIT 1"
    ).get(card.column_id, colName) as { id: number } | undefined;

    if (col) {
      const agentStatus = status === 'done' || status === 'pr_ready' ? 'completed' : status === 'building' ? 'working' : 'idle';
      db.prepare("UPDATE cards SET column_id = ?, agent_status = ?, updated_at = datetime('now') WHERE id = ?")
        .run(col.id, agentStatus, card_id);
    }

    db.prepare("INSERT INTO activity_log (card_id, action, actor) VALUES (?, ?, 'agent')")
      .run(card_id, `card.${status}`);

    const updated = getCard(db, card_id);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: updated }) }] };
  });

  // Attach PR URL and branch to a card
  server.tool('antfarm_set_pr', {
    card_id: z.number(),
    pr_url: z.string().describe('GitHub PR URL'),
    branch: z.string().describe('Branch name'),
  }, async ({ card_id, pr_url, branch }) => {
    const card = setPr(db, card_id, pr_url, branch);
    if (!card) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Card not found' }) }] };
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: card }) }] };
  });

  // Add a note to a card
  server.tool('antfarm_add_note', {
    card_id: z.number(),
    content: z.string(),
    type: z.enum(['note', 'output', 'status_change', 'human_review_request']).optional(),
  }, async ({ card_id, content, type }) => {
    const note = addNote(db, card_id, content, 'agent', type ?? 'note');
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: note }) }] };
  });

  // Request human review — pauses agent and flags the task for human attention
  server.tool('antfarm_request_human_review', {
    task_id: z.number().describe('ID of the task to flag for review'),
    question: z.string().min(1).max(2000).describe('Question or context for the human reviewer'),
  }, async ({ task_id, question }) => {
    const trimmed = question.trim();
    if (!trimmed) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Question cannot be empty' }) }] };
    }

    const card = getCard(db, task_id);
    if (!card) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Task not found' }) }] };
    }

    updateCard(db, task_id, { agent_status: 'waiting' });

    const noteContent = `[Human Review Request] ${trimmed}`;
    addNote(db, task_id, noteContent, 'agent', 'human_review_request');

    db.prepare(
      "INSERT INTO activity_log (card_id, action, actor, details_json) VALUES (?, 'card.human_review_requested', 'agent', ?)"
    ).run(task_id, JSON.stringify({ question: trimmed, session_id: sessionId }));

    const updated = getCard(db, task_id);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { card: updated, message: 'Task is now awaiting human review' } }) }] };
  });

  // Get project context (all CLAUDE.md files for the board's directory)
  server.tool('antfarm_get_project_context', {
    board_id: z.number().optional(),
  }, async ({ board_id }) => {
    const boards = getBoards(db);
    const targetId = board_id ?? boards[0]?.id;
    if (!targetId) return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: [] }) }] };
    const context = getProjectContext(db, targetId);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: context }) }] };
  });

  // Heartbeat to prevent lease expiration
  server.tool('antfarm_heartbeat', { card_id: z.number() }, async ({ card_id }) => {
    touchCard(db, card_id, sessionId);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
  });

  // Add subtask
  server.tool('antfarm_add_subtask', {
    card_id: z.number(),
    text: z.string(),
  }, async ({ card_id, text }) => {
    const subtask = addSubtask(db, card_id, text);
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: subtask }) }] };
  });

  // Complete subtask
  server.tool('antfarm_complete_subtask', {
    subtask_id: z.number(),
  }, async ({ subtask_id }) => {
    const subtask = completeSubtask(db, subtask_id);
    if (!subtask) return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'Not found' }) }] };
    return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: subtask }) }] };
  });

  // Returns and claims the highest-priority unblocked idle card
  server.tool('antfarm_get_next_available', {
    agent_id: z.string().describe('ID of the agent requesting work'),
    board_id: z.number().optional().describe('Board ID. Omit for default board.'),
  }, async ({ agent_id, board_id }) => {
    const boards = getBoards(db);
    const targetId = board_id ?? boards[0]?.id;
    if (!targetId) {
      return { content: [{ type: 'text', text: JSON.stringify({ found: false, reason: 'no_boards_exist' }) }] };
    }
    const result = getNextAvailableCard(db, agent_id, targetId);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[antfarm] MCP server started. Session: ${sessionId}`);
}
