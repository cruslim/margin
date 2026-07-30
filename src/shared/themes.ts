/** Color tokens every theme defines; keys map to the CSS custom properties in styles.css. */
export const THEME_TOKENS = {
  bg: '--bg',
  bgPanel: '--bg-panel',
  bgRaised: '--bg-raised',
  border: '--border',
  text: '--text',
  textDim: '--text-dim',
  accent: '--accent',
  accentContrast: '--accent-contrast',
  icon: '--icon',
  ok: '--ok',
  warn: '--warn',
  err: '--err',
  crit: '--crit',
} as const;

export type ThemeColors = Record<keyof typeof THEME_TOKENS, string>;

export interface Theme {
  name: string;
  /** Flips the diff viewer + syntax highlighting between dark and light. */
  mode: 'dark' | 'light';
  colors: ThemeColors;
}

/** Themes stored in settings: which one is active, plus user-made copies. */
export interface ThemeSettings {
  active: string;
  custom: Theme[];
}

export const PRESET_THEMES: Theme[] = [
  {
    // The palette Margin shipped with.
    name: 'Tokyo Night',
    mode: 'dark',
    colors: {
      bg: '#16161e', bgPanel: '#1b1b26', bgRaised: '#22222e', border: '#2c2c3a',
      text: '#d5d6e0', textDim: '#8b8ca0', accent: '#7aa2f7', accentContrast: '#10101a', icon: '#8b8ca0',
      ok: '#9ece6a', warn: '#e0af68', err: '#f7768e', crit: '#ff5370',
    },
  },
  {
    name: 'Graphite',
    mode: 'dark',
    colors: {
      bg: '#131313', bgPanel: '#191919', bgRaised: '#232323', border: '#2f2f2f',
      text: '#d6d6d6', textDim: '#8f8f8f', accent: '#8ab4f8', accentContrast: '#101010', icon: '#8f8f8f',
      ok: '#a3be8c', warn: '#ebcb8b', err: '#bf616a', crit: '#e5534b',
    },
  },
  {
    name: 'Paper',
    mode: 'light',
    colors: {
      bg: '#fafaf8', bgPanel: '#f1f1ee', bgRaised: '#e8e8e3', border: '#d8d8d1',
      text: '#2b2b33', textDim: '#6f6f7a', accent: '#3a5ccc', accentContrast: '#ffffff', icon: '#6f6f7a',
      ok: '#4d8b31', warn: '#b26a00', err: '#c43f55', crit: '#d31f2b',
    },
  },
  {
    // nordtheme.com — polar night / snow storm / frost / aurora.
    name: 'Nord',
    mode: 'dark',
    colors: {
      bg: '#2e3440', bgPanel: '#333a48', bgRaised: '#3b4252', border: '#4c566a',
      text: '#e5e9f0', textDim: '#8b96ab', accent: '#88c0d0', accentContrast: '#10141d', icon: '#8b96ab',
      ok: '#a3be8c', warn: '#ebcb8b', err: '#bf616a', crit: '#c9414f',
    },
  },
  {
    // github.com/morhetz/gruvbox — dark, medium contrast.
    name: 'Gruvbox',
    mode: 'dark',
    colors: {
      bg: '#282828', bgPanel: '#32302f', bgRaised: '#3c3836', border: '#504945',
      text: '#ebdbb2', textDim: '#928374', accent: '#83a598', accentContrast: '#1d2021', icon: '#928374',
      ok: '#b8bb26', warn: '#fabd2f', err: '#fb4934', crit: '#cc241d',
    },
  },
];

/**
 * Normalize theme settings from disk — settings.json is hand-editable, so
 * malformed shapes (custom as an object, entries without a name) must degrade
 * to defaults instead of crashing resolveTheme.
 */
export function sanitizeThemeSettings(stored: unknown): ThemeSettings {
  const t = (stored && typeof stored === 'object' ? stored : {}) as Partial<ThemeSettings>;
  const custom = Array.isArray(t.custom)
    ? t.custom
        .filter(
          (x): x is Theme =>
            !!x && typeof x === 'object' && typeof x.name === 'string' && !!x.colors && typeof x.colors === 'object',
        )
        .map((x) => ({ name: x.name, mode: x.mode === 'light' ? ('light' as const) : ('dark' as const), colors: { ...x.colors } }))
    : [];
  return { active: typeof t.active === 'string' ? t.active : PRESET_THEMES[0].name, custom };
}

/** Custom themes shadow presets with the same name; unknown/missing falls back to the first preset. */
export function resolveTheme(themes: ThemeSettings | undefined): Theme {
  const all = [...(themes?.custom ?? []), ...PRESET_THEMES];
  return all.find((t) => t.name === themes?.active) ?? PRESET_THEMES[0];
}
