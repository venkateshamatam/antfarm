// Generates a unique session ID for each MCP server process.
// Each Claude Code session spawns its own MCP process via stdio,
// so each process gets a unique ID used for card claiming.

import { v4 as uuidv4 } from 'uuid';

let sessionId: string | null = null;

export function getSessionId(): string {
  if (!sessionId) {
    sessionId = `antfarm-${uuidv4().slice(0, 8)}`;
  }
  return sessionId;
}
