import { describe, expect, it } from 'vitest';
import {
  agentValue,
  answererFromSetting,
  answererOf,
  ANSWER_EXTERNAL,
  ANSWER_REVIEWER,
  SETTING_MY_AGENT,
  SETTING_REVIEWER,
} from './answerer.js';

describe('answererOf', () => {
  it('maps the reviewer to no routing at all', () => {
    expect(answererOf(ANSWER_REVIEWER)).toEqual({});
  });

  it('maps the handoff to an external thread', () => {
    expect(answererOf(ANSWER_EXTERNAL)).toEqual({ external: true });
  });

  it('maps a specialist to its name', () => {
    expect(answererOf(agentValue('security'))).toEqual({ agent: 'security' });
  });

  it('keeps a specialist named like the handoff a specialist', () => {
    // The namespace is the whole point: an agent called "external" must not
    // silently start routing threads out of the app.
    expect(answererOf(agentValue('external'))).toEqual({ agent: 'external' });
  });

  it('keeps names containing the prefix intact', () => {
    expect(answererOf(agentValue('agent:nested'))).toEqual({ agent: 'agent:nested' });
  });

  it('treats an unrecognized value as the reviewer', () => {
    expect(answererOf('whatever')).toEqual({});
  });
});

describe('answererFromSetting', () => {
  const agents = ['security', 'performance'];

  it('maps the spelled-out settings values', () => {
    expect(answererFromSetting(SETTING_REVIEWER, agents)).toBe(ANSWER_REVIEWER);
    expect(answererFromSetting(SETTING_MY_AGENT, agents)).toBe(ANSWER_EXTERNAL);
  });

  it('maps a configured specialist by name, with or without the @', () => {
    expect(answererFromSetting('security', agents)).toBe(agentValue('security'));
    expect(answererFromSetting('@security', agents)).toBe(agentValue('security'));
  });

  it('tolerates surrounding whitespace from a hand-edited file', () => {
    expect(answererFromSetting('  my-agent  ', agents)).toBe(ANSWER_EXTERNAL);
  });

  it('falls back to the reviewer for a specialist that no longer exists', () => {
    // Renaming or deleting an agent must not leave threads routed at a ghost —
    // chat() throws on an unknown specialist.
    expect(answererFromSetting('security', [])).toBe(ANSWER_REVIEWER);
    expect(answererFromSetting('typo', agents)).toBe(ANSWER_REVIEWER);
    expect(answererFromSetting('', agents)).toBe(ANSWER_REVIEWER);
  });
});
