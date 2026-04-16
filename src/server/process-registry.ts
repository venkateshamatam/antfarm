// Shared registry for spawned processes so the terminal WebSocket
// can stream their output live to the browser.

import type { ChildProcess } from 'child_process';
import { WebSocket } from 'ws';

interface LiveProcess {
  proc: ChildProcess;
  cardId: number;
  type: 'spec' | 'build' | 'plan';
  buffer: string[];   // ring buffer of recent output
  clients: Set<WebSocket>;
}

const MAX_BUFFER = 5000;
const registry = new Map<number, LiveProcess>();

// Register a spawned process for a card
export function registerProcess(cardId: number, proc: ChildProcess, type: 'spec' | 'build' | 'plan') {
  const entry: LiveProcess = {
    proc,
    cardId,
    type,
    buffer: [],
    clients: new Set(),
  };

  const broadcast = (data: string) => {
    entry.buffer.push(data);
    if (entry.buffer.length > MAX_BUFFER) {
      entry.buffer = entry.buffer.slice(-MAX_BUFFER);
    }
    const msg = JSON.stringify({ type: 'data', data });
    for (const ws of entry.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  };

  // Parse stream-json and extract human-readable content for the terminal
  let jsonBuf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    jsonBuf += chunk.toString();
    // Try to parse complete JSON objects from the buffer
    const lines = jsonBuf.split('\n');
    jsonBuf = lines.pop() || '';
    for (const line of lines) {
      const trimLine = line.trim();
      if (!trimLine) continue;
      try {
        const obj = JSON.parse(trimLine);
        if (obj.type === 'assistant' && obj.message?.content) {
          for (const block of obj.message.content) {
            if (block.type === 'text' && block.text) {
              broadcast(block.text);
            } else if (block.type === 'tool_use') {
              // Show tool name + relevant details
              const input = block.input || {};
              let detail = '';
              if (block.name === 'Read' && input.file_path) detail = ` ${input.file_path}`;
              else if (block.name === 'Edit' && input.file_path) detail = ` ${input.file_path}`;
              else if (block.name === 'Write' && input.file_path) detail = ` ${input.file_path}`;
              else if (block.name === 'Bash' && input.command) detail = ` ${String(input.command).substring(0, 80)}`;
              else if (block.name === 'Grep' && input.pattern) detail = ` "${input.pattern}"${input.path ? ` in ${input.path}` : ''}`;
              else if (block.name === 'Glob' && input.pattern) detail = ` ${input.pattern}`;
              broadcast(`\r\n\x1b[36m> ${block.name}${detail}\x1b[0m\r\n`);
            }
          }
        } else if (obj.type === 'result') {
          broadcast(`\r\n\x1b[32m--- Complete ---\x1b[0m\r\n`);
        } else if (obj.type === 'system' && obj.subtype === 'init') {
          broadcast(`\x1b[90mSession ${obj.session_id}\x1b[0m\r\n`);
        }
        // Silently skip: hook events, rate_limit, system notifications
      } catch {
        // Not parseable JSON — could be partial chunk or raw text
        // Don't broadcast partial JSON, wait for complete line
      }
    }
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    broadcast(`\x1b[31m${chunk.toString()}\x1b[0m`);
  });

  proc.on('close', (exitCode) => {
    const msg = JSON.stringify({ type: 'exit', exitCode });
    for (const ws of entry.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
    // Keep in registry for 60s so reconnects can replay buffer
    setTimeout(() => {
      if (registry.get(cardId) === entry) {
        registry.delete(cardId);
      }
    }, 60000);
  });

  registry.set(cardId, entry);
  return entry;
}

// Get a live process for a card (for WebSocket connections)
export function getProcess(cardId: number): LiveProcess | undefined {
  return registry.get(cardId);
}

// Subscribe a WebSocket to a live process
export function subscribeToProcess(cardId: number, ws: WebSocket): boolean {
  const entry = registry.get(cardId);
  if (!entry) return false;

  entry.clients.add(ws);

  // Send info
  ws.send(JSON.stringify({
    type: 'info',
    cardId,
    command: `claude (${entry.type})`,
    alive: !entry.proc.killed && entry.proc.exitCode === null,
  }));

  // Replay buffer
  if (entry.buffer.length > 0) {
    ws.send(JSON.stringify({ type: 'data', data: entry.buffer.join('') }));
  }

  // If process already exited, send exit event
  if (entry.proc.exitCode !== null) {
    ws.send(JSON.stringify({ type: 'exit', exitCode: entry.proc.exitCode }));
  }

  ws.on('close', () => entry.clients.delete(ws));
  ws.on('error', () => entry.clients.delete(ws));

  return true;
}

// Remove a card's process from registry
export function unregisterProcess(cardId: number) {
  registry.delete(cardId);
}

// Kill a running process for a card and clean up
export function killProcess(cardId: number): boolean {
  const entry = registry.get(cardId);
  if (!entry) return false;

  try {
    if (!entry.proc.killed && entry.proc.exitCode === null) {
      // Kill the process tree (SIGTERM first, then SIGKILL after 3s)
      entry.proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (!entry.proc.killed && entry.proc.exitCode === null) {
            entry.proc.kill('SIGKILL');
          }
        } catch { /* already dead */ }
      }, 3000);
    }
  } catch { /* already dead */ }

  // Notify connected WebSocket clients
  const msg = JSON.stringify({ type: 'exit', exitCode: -1, signal: 'cancelled' });
  for (const ws of entry.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }

  registry.delete(cardId);
  return true;
}
