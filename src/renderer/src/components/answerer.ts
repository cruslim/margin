/**
 * Who answers a comment thread, as encoded by the composer's picker.
 *
 * Values are namespaced so a specialist can never be mistaken for the handoff —
 * someone is free to name an agent "external", and `agent:external` still reads
 * as a specialist.
 */
export const ANSWER_REVIEWER = '';
export const ANSWER_EXTERNAL = 'external';
const AGENT_PREFIX = 'agent:';

/** Picker value for a configured specialist. */
export function agentValue(name: string): string {
  return `${AGENT_PREFIX}${name}`;
}

/** Split a picker value into the fields a Comment carries. */
export function answererOf(value: string): { agent?: string; external?: boolean } {
  if (value === ANSWER_EXTERNAL) return { external: true };
  return value.startsWith(AGENT_PREFIX) ? { agent: value.slice(AGENT_PREFIX.length) } : {};
}

/** How AppSettings.defaultAnswerer spells the handoff. */
export const SETTING_MY_AGENT = 'my-agent';
export const SETTING_REVIEWER = 'reviewer';

/**
 * Turn the stored preference into a picker value. Anything unrecognized — most
 * likely a specialist that has since been renamed or deleted — falls back to the
 * reviewer rather than routing a thread somewhere that no longer exists.
 */
export function answererFromSetting(setting: string, agents: string[]): string {
  const choice = setting.trim();
  if (choice === SETTING_MY_AGENT) return ANSWER_EXTERNAL;
  // Tolerate a leading @, since that's how the UI shows specialists.
  const name = choice.replace(/^@/, '');
  return agents.includes(name) ? agentValue(name) : ANSWER_REVIEWER;
}
