import { query } from '@anthropic-ai/claude-agent-sdk';

export interface ChatReply {
  sessionId: string;
  text: string;
  costUsd: number | null;
}

export interface ChatEvents {
  onProgress?: (line: string) => void;
}

const FRESH_SESSION_PROMPT = `You are Margin, a code review assistant. You are answering questions about a changeset inside a checkout of the repository. Explore with Read/Grep/Glob to ground your answers in the actual code. Be concise and concrete.`;

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
): Promise<ChatReply> {
  let newSessionId = sessionId ?? '';
  let text = '';
  let costUsd: number | null = null;

  const stream = query({
    prompt: message,
    options: {
      ...(sessionId ? { resume: sessionId } : { systemPrompt: FRESH_SESSION_PROMPT }),
      cwd: workDir,
      allowedTools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'],
      maxTurns: 30,
      ...(process.versions.electron ? { executable: 'node' as const } : {}),
    },
  });

  for await (const msg of stream) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      newSessionId = msg.session_id;
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

  return { sessionId: newSessionId, text, costUsd };
}
