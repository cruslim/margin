import { query, type AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { delegationPrompt } from './agents.js';
import { mergeInstructions, readRepoGuidance } from './instructions.js';

export interface ChatReply {
  sessionId: string;
  text: string;
  costUsd: number | null;
}

export interface ChatEvents {
  onProgress?: (line: string) => void;
  /** Streaming text deltas of the assistant's reply, as they're generated. */
  onTextDelta?: (delta: string) => void;
}

export interface ChatOptions {
  model?: string;
  /** User's app-stored per-repo instructions — only used when starting a fresh session. */
  instructions?: string;
  /** Named specialist subagents available for delegation. */
  agents?: Record<string, AgentDefinition>;
  /** Route this turn to one of `agents` via subagent delegation. */
  agent?: string;
}

const FRESH_SESSION_PROMPT = `You are Margin, a code review assistant. You are answering questions about a changeset inside a checkout of the repository. Explore with Read/Grep/Glob to ground your answers in the actual code. Be concise and concrete.`;

/** System prompt for a fresh (non-resumed) session, with project instructions appended when present. */
export function freshSessionPrompt(projectInstructions: string): string {
  if (!projectInstructions.trim()) return FRESH_SESSION_PROMPT;
  return `${FRESH_SESSION_PROMPT}\n\nProject-specific instructions (follow these):\n${projectInstructions.trim()}`;
}

/**
 * Send a chat turn. With a sessionId, resumes that review session — it keeps
 * everything the reviewer already read and found. With null (commenting before
 * any review ran), starts a fresh session in the workDir.
 */
export async function chat(
  sessionId: string | null,
  workDir: string,
  message: string,
  events: ChatEvents = {},
  opts: ChatOptions = {},
): Promise<ChatReply> {
  let newSessionId = sessionId ?? '';
  let text = '';
  let costUsd: number | null = null;

  // Resumed review sessions already saw the project instructions in the review
  // prompt; fresh sessions (commenting before any review ran) need them here.
  const projectInstructions = sessionId
    ? ''
    : mergeInstructions(opts.instructions, await readRepoGuidance(workDir));

  // Subagents (and the Task tool that spawns them) are only exposed on turns
  // that explicitly target an agent, so plain turns stay deterministic. A
  // targeted agent that is no longer configured is an error — silently
  // answering as the plain reviewer would misattribute the reply.
  if (opts.agent && !opts.agents?.[opts.agent]) {
    throw new Error(`Unknown specialist agent "${opts.agent}" — it may have been removed from settings.`);
  }
  const delegate = opts.agent;

  const stream = query({
    prompt: delegate ? delegationPrompt(delegate, message) : message,
    options: {
      ...(sessionId ? { resume: sessionId } : { systemPrompt: freshSessionPrompt(projectInstructions) }),
      ...(delegate ? { agents: opts.agents } : {}),
      cwd: workDir,
      allowedTools: delegate ? ['Read', 'Grep', 'Glob', 'Task'] : ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      maxTurns: 30,
      ...(opts.model ? { model: opts.model } : {}),
      ...(events.onTextDelta ? { includePartialMessages: true } : {}),
      ...(process.versions.electron ? { executable: 'node' as const } : {}),
      ...(process.env.MARGIN_CLI_PATH ? { pathToClaudeCodeExecutable: process.env.MARGIN_CLI_PATH } : {}),
    },
  });

  try {
  for await (const msg of stream) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      newSessionId = msg.session_id;
    } else if (msg.type === 'stream_event') {
      const e = msg.event;
      if (e.type === 'content_block_delta' && e.delta.type === 'text_delta' && !msg.parent_tool_use_id) {
        events.onTextDelta?.(e.delta.text);
      }
    } else if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          const input = block.input as Record<string, unknown>;
          events.onProgress?.(`[tool] ${block.name} ${String(input.file_path ?? input.pattern ?? '')}`);
        }
      }
    } else if (msg.type === 'result') {
      costUsd = 'total_cost_usd' in msg ? msg.total_cost_usd : null;
      if (msg.subtype === 'success') {
        text = msg.result;
      } else {
        throw new Error(`Chat turn failed: ${msg.subtype}`);
      }
    }
  }
  } catch (err) {
    // Don't discard a delivered reply over a post-result CLI shutdown error.
    if (!text) throw err;
  }

  return { sessionId: newSessionId, text, costUsd };
}
