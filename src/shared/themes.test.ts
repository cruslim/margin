import { describe, expect, it } from 'vitest';
import { PRESET_THEMES, resolveTheme, sanitizeThemeSettings, THEME_TOKENS, type Theme } from './themes.js';

const custom: Theme = { ...PRESET_THEMES[0], name: 'Mine', colors: { ...PRESET_THEMES[0].colors, accent: '#123456' } };

describe('PRESET_THEMES', () => {
  it('every preset defines every token as 6-digit hex (color inputs require it)', () => {
    for (const theme of PRESET_THEMES) {
      for (const key of Object.keys(THEME_TOKENS)) {
        expect(theme.colors[key as keyof typeof THEME_TOKENS], `${theme.name}.${key}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it('preset names are unique', () => {
    const names = PRESET_THEMES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('resolveTheme', () => {
  it('falls back to the first preset when unset or unknown', () => {
    expect(resolveTheme(undefined)).toBe(PRESET_THEMES[0]);
    expect(resolveTheme({ active: 'nope', custom: [] })).toBe(PRESET_THEMES[0]);
  });

  it('finds presets and custom themes by name', () => {
    expect(resolveTheme({ active: 'Paper', custom: [] }).mode).toBe('light');
    expect(resolveTheme({ active: 'Mine', custom: [custom] }).colors.accent).toBe('#123456');
  });

  it('a custom theme shadows a preset with the same name', () => {
    const shadow: Theme = { ...custom, name: 'Tokyo Night' };
    expect(resolveTheme({ active: 'Tokyo Night', custom: [shadow] })).toBe(shadow);
  });
});

describe('sanitizeThemeSettings', () => {
  it('passes valid settings through', () => {
    const out = sanitizeThemeSettings({ active: 'Mine', custom: [custom] });
    expect(out.active).toBe('Mine');
    expect(out.custom).toHaveLength(1);
    expect(out.custom[0].colors.accent).toBe('#123456');
  });

  it('degrades hand-edited garbage to defaults instead of crashing', () => {
    // The shape CodeRabbit flagged: custom as an object crashes resolveTheme's spread.
    expect(sanitizeThemeSettings({ custom: {} }).custom).toEqual([]);
    expect(sanitizeThemeSettings(null).active).toBe(PRESET_THEMES[0].name);
    expect(sanitizeThemeSettings('nope').custom).toEqual([]);
    expect(sanitizeThemeSettings({ active: 42, custom: [null, { name: 7 }, { name: 'ok' }] })).toEqual({
      active: PRESET_THEMES[0].name,
      custom: [],
    });
  });

  it('normalizes mode and keeps valid entries among invalid ones', () => {
    const out = sanitizeThemeSettings({ active: 'x', custom: [{ name: 'x', mode: 'neon', colors: { bg: '#000000' } }, 'junk'] });
    expect(out.custom).toEqual([{ name: 'x', mode: 'dark', colors: { bg: '#000000' } }]);
  });
});
