import { describe, expect, it } from 'vitest';
import { chat, freshSessionPrompt } from './chat.js';

describe('freshSessionPrompt', () => {
  it('returns the base prompt when there are no project instructions', () => {
    expect(freshSessionPrompt('')).not.toContain('Project-specific');
    expect(freshSessionPrompt('   \n')).not.toContain('Project-specific');
  });

  it('appends project instructions when present', () => {
    const prompt = freshSessionPrompt('- money amounts are integer cents\n');
    expect(prompt).toContain('You are Margin');
    expect(prompt).toContain('Project-specific instructions (follow these):');
    expect(prompt).toContain('- money amounts are integer cents');
    expect(prompt.endsWith('integer cents')).toBe(true);
  });
});

describe('chat with a specialist agent', () => {
  it('rejects a turn targeting an agent that is not configured', async () => {
    // Throws before any process is spawned — a deleted agent must not silently
    // downgrade the thread to a plain reviewer turn.
    await expect(
      chat('some-session', '/tmp', 'question', {}, { agent: 'ghost', agents: {} }),
    ).rejects.toThrow(/Unknown specialist agent "ghost"/);
  });
});
