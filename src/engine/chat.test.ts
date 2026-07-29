import { describe, expect, it } from 'vitest';
import { freshSessionPrompt } from './chat.js';

describe('freshSessionPrompt', () => {
  it('returns the base prompt when there are no project instructions', () => {
    expect(freshSessionPrompt('')).not.toContain('.margin.md');
    expect(freshSessionPrompt('   \n')).not.toContain('.margin.md');
  });

  it('appends .margin.md instructions when present', () => {
    const prompt = freshSessionPrompt('- money amounts are integer cents\n');
    expect(prompt).toContain('You are Margin');
    expect(prompt).toContain('Project-specific instructions (from .margin.md — follow these):');
    expect(prompt).toContain('- money amounts are integer cents');
    expect(prompt.endsWith('integer cents')).toBe(true);
  });
});
