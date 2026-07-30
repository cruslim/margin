import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

/** User-configured specialist agent (AppSettings.agents). */
export interface AgentConfig {
  name: string;
  description: string;
  instructions: string;
  /** SDK subagents accept only these tiers; anything else falls back to the session model. */
  model?: string;
}

const SUBAGENT_MODELS = new Set(['sonnet', 'opus', 'haiku']);

/**
 * Convert configured agents to SDK subagent definitions. Tools are always
 * read-only — user-defined agents must not escape Margin's sandbox.
 */
export function toAgentDefinitions(agents: AgentConfig[]): Record<string, AgentDefinition> {
  const defs: Record<string, AgentDefinition> = {};
  for (const a of agents) {
    const name = a.name.trim();
    if (!name || !a.instructions.trim()) continue;
    defs[name] = {
      description: a.description.trim() || `Specialist agent "${name}"`,
      prompt: a.instructions.trim(),
      tools: ['Read', 'Grep', 'Glob'],
      ...(a.model && SUBAGENT_MODELS.has(a.model) ? { model: a.model as 'sonnet' | 'opus' | 'haiku' } : {}),
    };
  }
  return defs;
}

/**
 * Wrap a chat turn so the main agent delegates it to a named subagent.
 * Subagents cannot see the conversation history, so the parent is told to
 * brief them with the context they need (spike-verified: without this the
 * subagent answers blind).
 */
export function delegationPrompt(agent: string, message: string): string {
  return (
    `Handle the following by delegating to the "${agent}" subagent via the Task tool. ` +
    'When briefing it, include everything it needs from our conversation so far ' +
    '(file paths, code, findings, prior discussion) — it cannot see the conversation history, ' +
    'though it can read the repository itself. Relay its full answer back.\n\n' +
    message
  );
}
