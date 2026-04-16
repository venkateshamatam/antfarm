// Terminal session manager for Antfarm
// Uses child_process.spawn instead of node-pty to avoid native module issues.
// Pipes stdout/stderr to WebSocket clients, stdin from WebSocket to the process.
// Ring buffer keeps recent output for reconnects.

import { spawn, type ChildProcess } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import fs from 'fs';
import { subscribeToProcess } from './process-registry.js';
// getProcess available if needed for status checks

const BUFFER_SIZE = 5000;

interface TermSession {
  proc: ChildProcess;
  clients: Set<WebSocket>;
  buffer: string[];
  command: string;
  alive: boolean;
}

const sessions = new Map<number, TermSession>();

function createSession(cardId: number, cwd: string, sessionId: string | null): TermSession {
  const safeCwd = (cwd && fs.existsSync(cwd)) ? cwd : (process.env.HOME || '/tmp');

  let cmd: string;
  let args: string[];

  // For claude --resume: open /dev/null as stdin to avoid the
  // "no stdin data received in 3s" warning, and pass -p to handle completed sessions
  let stdinFd: number | undefined;
  if (sessionId) {
    cmd = 'claude';
    args = ['--resume', sessionId, '-p', 'Continue where you left off. Show a brief summary of what was done.', '--output-format', 'stream-json'];
    try { stdinFd = fs.openSync('/dev/null', 'r'); } catch { /* fallback to pipe */ }
  } else {
    cmd = process.env.SHELL || '/bin/zsh';
    args = [];
  }

  const proc = spawn(cmd, args, {
    cwd: safeCwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    stdio: [stdinFd != null ? stdinFd : 'pipe', 'pipe', 'pipe'],
  });

  // Close the fd after spawn takes ownership
  if (stdinFd != null) {
    try { fs.closeSync(stdinFd); } catch { /* already closed */ }
  }

  const session: TermSession = {
    proc,
    clients: new Set(),
    buffer: [],
    command: sessionId ? `claude --resume ${sessionId}` : cmd,
    alive: true,
  };

  const broadcast = (data: string) => {
    // Ring buffer
    session.buffer.push(data);
    if (session.buffer.length > BUFFER_SIZE) {
      session.buffer = session.buffer.slice(-BUFFER_SIZE);
    }
    const msg = JSON.stringify({ type: 'data', data });
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  };

  if (sessionId) {
    // Parse stream-json output from claude CLI
    let jsonBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      jsonBuf += chunk.toString();
      const lines = jsonBuf.split('\n');
      jsonBuf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed);
          if (obj.type === 'assistant' && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text) {
                broadcast(block.text);
              } else if (block.type === 'tool_use') {
                const input = block.input || {};
                let detail = '';
                if (input.file_path) detail = ` ${input.file_path}`;
                else if (input.command) detail = ` ${String(input.command).substring(0, 80)}`;
                else if (input.pattern) detail = ` "${input.pattern}"`;
                broadcast(`\r\n\x1b[36m> ${block.name}${detail}\x1b[0m\r\n`);
              }
            }
          } else if (obj.type === 'result') {
            broadcast(`\r\n\x1b[32m--- Session complete ---\x1b[0m\r\n`);
          }
        } catch {
          // Not JSON, broadcast as-is
          broadcast(trimmed);
        }
      }
    });
  } else {
    proc.stdout?.on('data', (chunk: Buffer) => broadcast(chunk.toString()));
  }
  proc.stderr?.on('data', (chunk: Buffer) => broadcast(chunk.toString()));

  proc.on('close', (exitCode, signal) => {
    session.alive = false;
    const msg = JSON.stringify({ type: 'exit', exitCode, signal });
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
    setTimeout(() => {
      if (sessions.get(cardId) === session) {
        sessions.delete(cardId);
      }
    }, 30000);
  });

  proc.on('error', (err) => {
    session.alive = false;
    const msg = JSON.stringify({ type: 'error', message: err.message });
    for (const ws of session.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  });

  sessions.set(cardId, session);
  return session;
}

export function setupPtyWebSocket(server: Server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket: any, head: any) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const match = url.pathname.match(/^\/ws\/pty\/(\d+)$/);

    if (!match) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const cardId = Number(match[1]);
      handleConnection(ws, cardId, url.searchParams);
    });
  });

  return wss;
}

function handleConnection(ws: WebSocket, cardId: number, params: URLSearchParams) {
  const cwd = params.get('cwd') || process.cwd();
  const sessionId = params.get('sessionId') || null;

  // First check: is there a live spawner process for this card?
  // (from spec generation or building)
  if (subscribeToProcess(cardId, ws)) {
    return; // Connected to live spawner output
  }

  let session = sessions.get(cardId);

  // If there's a dead session, clean it up so we can start fresh
  if (session && !session.alive) {
    sessions.delete(cardId);
    session = undefined;
  }

  // No active session — spawn one if we have a session ID
  if (!session) {
    if (!sessionId) {
      ws.send(JSON.stringify({ type: 'info', cardId, command: null, alive: false }));
      ws.send(JSON.stringify({ type: 'data', data: 'No active session for this card.\r\nGenerate a spec or approve a build to start one.' }));
      ws.on('close', () => {});
      return;
    }
    try {
      session = createSession(cardId, cwd, sessionId);
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', message: `Failed to start: ${err.message}` }));
      ws.close();
      return;
    }
  }

  session.clients.add(ws);

  // Send session info
  ws.send(JSON.stringify({
    type: 'info',
    cardId,
    command: session.command,
    alive: session.alive,
  }));

  // Replay ring buffer
  if (session.buffer.length > 0) {
    ws.send(JSON.stringify({ type: 'data', data: session.buffer.join('') }));
  }

  ws.on('message', (raw: any) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input' && session?.alive && session.proc.stdin) {
        session.proc.stdin.write(msg.data);
      }
      if (msg.type === 'resize' && session?.alive && session.proc.pid) {
        // Send SIGWINCH to notify the process of terminal resize
        try { process.kill(session.proc.pid, 'SIGWINCH'); } catch { /* process may have exited */ }
      }
    } catch { /* ignore */ }
  });

  ws.on('close', () => { session?.clients.delete(ws); });
  ws.on('error', () => { session?.clients.delete(ws); });
}

export function cleanupAllPtySessions() {
  for (const [cardId, session] of sessions) {
    try { session.proc.kill(); } catch { /* already dead */ }
    sessions.delete(cardId);
  }
}

export function getActiveSessions() {
  return Array.from(sessions.entries()).map(([cardId, session]) => ({
    cardId,
    command: session.command,
    alive: session.alive,
    clients: session.clients.size,
  }));
}
