/**
 * evolvr MCP server
 *
 * Exposes 4 tools to any MCP-compatible agent:
 *   evolvr_record_tool_call  — log a single tool invocation
 *   evolvr_session_end       — finalize a task/session
 *   evolvr_get_lessons       — retrieve top lessons for the current agent
 *   evolvr_get_status        — journal stats
 *
 * Start via: evolvr-mcp --project-root /path/to/project
 * Or via stdio transport (default, compatible with --mcp-config).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { parseArgs } from 'node:util';
import {
  Evolvr,
  loadConfig,
  defaultDbPath,
  createSqliteAdapter,
  createPostgresAdapter,
} from '@evolvr/core';

// ── CLI args ─────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    'project-root': { type: 'string', default: process.cwd() },
    'db-path': { type: 'string' },
    'postgres-url': { type: 'string' },
  },
  strict: false,
});

const projectRoot = args['project-root'] as string;

// ── Evolvr instance ──────────────────────────────────────────────────────────

const config = loadConfig(projectRoot);
const adapter = args['postgres-url']
  ? createPostgresAdapter(args['postgres-url'] as string)
  : createSqliteAdapter((args['db-path'] as string | undefined) ?? defaultDbPath(projectRoot));

const evolvr = new Evolvr(adapter, config);
await evolvr.init();

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'evolvr', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'evolvr_record_tool_call',
    description:
      'Record a single tool invocation into the evolvr task journal. ' +
      'Call this from a PostToolUse hook after every tool call.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID returned by evolvr_session_start or evolvr_get_status' },
        seq: { type: 'number', description: 'Sequential index of this tool call within the session (0-based)' },
        tool: { type: 'string', description: 'Tool name (e.g. "Read", "Bash", "write_file")' },
        args_hash: { type: 'string', description: 'SHA-256 hex of JSON-stringified tool arguments' },
        result_hash: { type: 'string', description: 'SHA-256 hex of JSON-stringified tool result' },
        result_summary: { type: 'string', description: 'First 200 chars of the result (for display)' },
        latency_ms: { type: 'number', description: 'Round-trip latency in milliseconds', default: 0 },
        repeated: { type: 'boolean', description: 'True if exact same args_hash+result_hash seen before in this session', default: false },
        token_cost: { type: 'number', description: 'Tokens consumed by this call', default: 0 },
      },
      required: ['task_id', 'seq', 'tool', 'args_hash', 'result_hash', 'result_summary'],
    },
  },
  {
    name: 'evolvr_session_end',
    description:
      'Finalize a task session. Runs the failure classifier and stores any lessons learned. ' +
      'Call this from a Stop hook when the agent finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to finalize' },
        outcome: {
          type: 'string',
          enum: ['success', 'partial', 'failed', 'loop_stopped'],
          description: 'Final outcome of the task',
        },
        reflection: { type: 'string', description: 'Optional agent self-assessment of what went wrong' },
        token_cost: { type: 'number', description: 'Total tokens consumed this session', default: 0 },
      },
      required: ['task_id', 'outcome'],
    },
  },
  {
    name: 'evolvr_get_lessons',
    description:
      'Retrieve top lessons learned from past failures, filtered for the current agent. ' +
      'Inject the returned text into the agent system prompt at session start.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name (e.g. "claude", "opencode", "codex")' },
        format: {
          type: 'string',
          enum: ['text', 'json'],
          description: 'Return format: text (for system prompt injection) or json',
          default: 'text',
        },
        limit: { type: 'number', description: 'Maximum number of lessons to return', default: 5 },
      },
      required: [],
    },
  },
  {
    name: 'evolvr_get_status',
    description: 'Get journal stats — task counts, success rate, lesson count.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ── ListTools ─────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── CallTool ──────────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'evolvr_record_tool_call': {
      const a = args as {
        task_id: string; seq: number; tool: string;
        args_hash: string; result_hash: string; result_summary: string;
        latency_ms?: number; repeated?: boolean; token_cost?: number;
      };
      await evolvr.recordToolCall(a.task_id, {
        seq: a.seq,
        tool: a.tool,
        args_hash: a.args_hash,
        result_hash: a.result_hash,
        result_summary: a.result_summary,
        latency_ms: a.latency_ms ?? 0,
        repeated: a.repeated ?? false,
        token_cost: a.token_cost ?? 0,
      });
      return { content: [{ type: 'text', text: 'recorded' }] };
    }

    case 'evolvr_session_end': {
      const a = args as {
        task_id: string; outcome: 'success' | 'partial' | 'failed' | 'loop_stopped';
        reflection?: string; token_cost?: number;
      };
      const task = await evolvr.completeTask(a.task_id, {
        outcome: a.outcome,
        reflection: a.reflection,
        token_cost: a.token_cost,
      });
      const text = task.failure_class
        ? `Session ended. Failure class detected: ${task.failure_class}. Lessons updated.`
        : `Session ended: ${task.outcome}.`;
      return { content: [{ type: 'text', text }] };
    }

    case 'evolvr_get_lessons': {
      const a = args as { agent?: string; format?: string; limit?: number };
      const lessons = await evolvr.getLessons({
        agent: a.agent,
        limit: a.limit ?? 5,
      });

      if (a.format === 'json') {
        return { content: [{ type: 'text', text: JSON.stringify(lessons, null, 2) }] };
      }

      const text = evolvr.formatLessonsForInjection(lessons);
      return { content: [{ type: 'text', text: text || '(no lessons yet)' }] };
    }

    case 'evolvr_get_status': {
      const stats = await evolvr.stats();
      const successRate = stats.total_tasks > 0
        ? ((stats.success_tasks / stats.total_tasks) * 100).toFixed(1)
        : '0.0';
      const text = [
        `Tasks: ${stats.total_tasks} total, ${stats.success_tasks} success, ${stats.failed_tasks} failed (${successRate}% success rate)`,
        `Lessons: ${stats.total_lessons} learned, ${stats.pending_lessons} pending`,
        `Agents: ${Object.entries(stats.agents).map(([a, n]) => `${a}=${n}`).join(', ') || 'none'}`,
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Graceful shutdown
process.on('SIGTERM', async () => {
  await evolvr.close();
  process.exit(0);
});
