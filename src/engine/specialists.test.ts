import { describe, expect, it } from 'vitest';
import { parseSpecialistOutput, rubricChecks, specialistPrompt, specialistSystemPrompt } from './specialists.js';

describe('rubricChecks', () => {
  it('splits lines, trims, and strips list markers', () => {
    expect(rubricChecks('- injection\n  * secrets logged \n\nrate limits')).toEqual([
      'injection',
      'secrets logged',
      'rate limits',
    ]);
  });

  it('is empty for an unset rubric', () => {
    expect(rubricChecks(undefined)).toEqual([]);
  });
});

describe('specialistSystemPrompt', () => {
  it('frames the agent by name with its instructions', () => {
    const prompt = specialistSystemPrompt({
      name: ' security ',
      description: '',
      instructions: 'Look only at authz.',
    });
    expect(prompt).toContain('You are "security"');
    expect(prompt).toContain('Look only at authz.');
    expect(prompt).toContain('decide whether this changeset touches your specialty');
  });
});

describe('specialistPrompt', () => {
  it('lists the rubric and demands each check in the output', () => {
    const prompt = specialistPrompt(['injection', 'secrets'], 'diff body', {}, '');
    expect(prompt).toContain('- injection');
    expect(prompt).toContain('- secrets');
    expect(prompt).toContain('every check must appear exactly once');
    expect(prompt).toContain('diff body');
  });

  it('puts the repo conventions ahead of the diff', () => {
    const prompt = specialistPrompt([], 'diff body', {}, '', '--- CLAUDE.md ---\nMax 10 deps.');
    expect(prompt).toContain('Max 10 deps.');
    expect(prompt.indexOf('Max 10 deps.')).toBeLessThan(prompt.indexOf('diff body'));
  });

  it('omits the rubric section when there are no checks', () => {
    const prompt = specialistPrompt([], 'diff body', {}, '');
    expect(prompt).not.toContain('Work through this rubric');
    expect(prompt).toContain('"checks"');
  });

  it('carries dismissals, instructions, and the incremental note', () => {
    const prompt = specialistPrompt([], 'd', {
      sinceSha: 'abc',
      dismissed: [{ file: 'a.ts', category: 'security', summary: 'old one', at: 1 }],
    }, 'Use tabs.');
    expect(prompt).toContain('INCREMENTAL review');
    expect(prompt).toContain('a.ts [security]: old one');
    expect(prompt).toContain('Use tabs.');
  });
});

describe('parseSpecialistOutput', () => {
  const finding = {
    file: 'a.ts',
    line: 1,
    severity: 'high',
    category: 'security',
    summary: 's',
    failureScenario: 'f',
    snippet: 'x',
  };

  it('tags findings with the specialist name', () => {
    const text = JSON.stringify({ ran: true, reason: 'auth touched', checks: [], findings: [finding] });
    const { report, findings } = parseSpecialistOutput(text, 'security');
    expect(findings[0].source).toBe('security');
    expect(report.agent).toBe('security');
    expect(report.ran).toBe(true);
    expect(report.reason).toBe('auth touched');
  });

  it('keeps valid checks and drops malformed rows', () => {
    const text = JSON.stringify({
      ran: true,
      reason: 'r',
      checks: [
        { check: 'injection', status: 'pass', note: 'parameterized everywhere' },
        { check: 'bad-status', status: 'meh', note: '' },
        { status: 'pass', note: 'no name' },
      ],
      findings: [],
    });
    const { report } = parseSpecialistOutput(text, 'security');
    expect(report.checks).toEqual([{ check: 'injection', status: 'pass', note: 'parameterized everywhere' }]);
  });

  it('empties checks and findings when the specialist skipped', () => {
    const text = JSON.stringify({
      ran: false,
      reason: 'no auth surface in this diff',
      checks: [{ check: 'x', status: 'pass', note: 'should be dropped' }],
      findings: [finding],
    });
    const { report, findings } = parseSpecialistOutput(text, 'security');
    expect(report.ran).toBe(false);
    expect(report.checks).toEqual([]);
    expect(findings).toEqual([]);
  });

  it('finds the JSON amid surrounding prose', () => {
    const text = `Here is my verdict:\n${JSON.stringify({ ran: true, reason: 'r', checks: [], findings: [] })}\nDone.`;
    expect(parseSpecialistOutput(text, 'security').report.ran).toBe(true);
  });

  it('throws when no JSON is present', () => {
    expect(() => parseSpecialistOutput('nothing here', 'security')).toThrow(/no parseable/);
  });
});
