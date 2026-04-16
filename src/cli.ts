#!/usr/bin/env node

// Antfarm CLI — entry point for both dashboard server and MCP server.
//
// Usage:
//   antfarm          → start dashboard server + open browser
//   antfarm serve    → start dashboard server only (no browser)
//   antfarm mcp      → start MCP server (stdio, for Claude Code)
//   antfarm setup    → configure MCP in ~/.claude/settings.json

import { startDashboardServer } from './server/index.js';
import { startMcpServer } from './mcp/server.js';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

const DEFAULT_PORT = 4800;
const DB_DIR = path.join(process.env.HOME ?? '~', '.antfarm');
const DB_PATH = path.join(DB_DIR, 'antfarm.db');
const CONFIG_PATH = path.join(DB_DIR, 'config.json');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

function getPort(): number {
  if (process.env.ANTFARM_PORT) return Number(process.env.ANTFARM_PORT);
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      if (config.port) return config.port;
    } catch {}
  }
  return DEFAULT_PORT;
}

// Auto-configure MCP in Claude Code settings
function setupMcp() {
  const claudeSettingsPath = path.join(process.env.HOME ?? '~', '.claude', 'settings.json');
  let settings: Record<string, any> = {};

  // Read existing settings
  if (fs.existsSync(claudeSettingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
    } catch {
      console.error('[antfarm] Warning: could not parse ~/.claude/settings.json');
    }
  } else {
    // Create .claude directory if needed
    const claudeDir = path.dirname(claudeSettingsPath);
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }
  }

  // Merge MCP server config (never overwrite, only add)
  if (!settings.mcpServers) settings.mcpServers = {};

  // Find the antfarm MCP binary path
  const mcpCommand = process.argv[1]; // path to this CLI script
  const mcpEntry = {
    command: 'node',
    args: [mcpCommand, 'mcp'],
    env: { ANTFARM_DB_PATH: DB_PATH },
  };

  if (settings.mcpServers.antfarm) {
    console.log('[antfarm] MCP server already configured in ~/.claude/settings.json');
  } else {
    settings.mcpServers.antfarm = mcpEntry;
    fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2));
    console.log('[antfarm] Added MCP server config to ~/.claude/settings.json');
  }
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'mcp': {
      // MCP server mode — stdio transport, spawned by Claude Code
      process.env.ANTFARM_DB_PATH = DB_PATH;
      await startMcpServer();
      break;
    }

    case 'serve': {
      // Dashboard server only, no browser open
      const port = getPort();
      await startDashboardServer(DB_PATH, port);
      break;
    }

    case 'setup': {
      setupMcp();
      break;
    }

    default: {
      // Default: set up MCP config, start dashboard, open browser
      setupMcp();
      const port = getPort();
      const actualPort = await startDashboardServer(DB_PATH, port);
      const url = `http://127.0.0.1:${actualPort}`;
      console.log(`[antfarm] Opening ${url} in your browser...`);
      exec(`open "${url}"`);
      break;
    }
  }
}

main().catch((err) => {
  console.error('[antfarm] Fatal error:', err.message);
  process.exit(1);
});
