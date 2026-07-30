import { describe, expect, it } from 'vitest';
import { delegationPrompt, toAgentDefinitions } from './agents.js';

describe('toAgentDefinitions', () => {
  it('converts configured agents with read-only tools forced', () => {
    const defs = toAgentDefinitions([
      { name: 'security', description: 'Security lens.', instructions: 'You are a security reviewer.' },
    ]);
    expect(defs.security).toEqual({
      description: 'Security lens.',
      prompt: 'You are a security reviewer.',
      tools: ['Read', 'Grep', 'Glob'],
    });
  });

  it('skips agents without a name or instructions', () => {
    const defs = toAgentDefinitions([
      { name: '  ', description: 'd', instructions: 'i' },
      { name: 'ok', description: 'd', instructions: '   ' },
      { name: 'kept', description: 'd', instructions: 'i' },
    ]);
    expect(Object.keys(defs)).toEqual(['kept']);
  });

  it('passes supported model tiers and drops unsupported ones', () => {
    const defs = toAgentDefinitions([
      { name: 'a', description: 'd', instructions: 'i', model: 'opus' },
      { name: 'b', description: 'd', instructions: 'i', model: 'claude-fable-5' },
    ]);
    expect(defs.a.model).toBe('opus');
    expect(defs.b.model).toBeUndefined();
  });

  it('defaults an empty description', () => {
    const defs = toAgentDefinitions([{ name: 'x', description: ' ', instructions: 'i' }]);
    expect(defs.x.description).toContain('x');
  });
});

describe('delegationPrompt', () => {
  it('names the agent and preserves the message', () => {
    const p = delegationPrompt('security', 'is this endpoint rate-limited?');
    expect(p).toContain('"security" subagent');
    expect(p).toContain('Task tool');
    expect(p.endsWith('is this endpoint rate-limited?')).toBe(true);
  });

  it('tells the parent to brief the subagent with conversation context', () => {
    expect(delegationPrompt('perf', 'q')).toContain('cannot see the conversation history');
  });
});
