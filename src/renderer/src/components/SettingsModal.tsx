import { useEffect, useState } from 'react';
import { SETTING_MY_AGENT, SETTING_REVIEWER } from './answerer.js';
import type { AppSettings } from '../../../shared/ipc.js';
import { PRESET_THEMES, resolveTheme, THEME_TOKENS, type Theme, type ThemeSettings } from '../../../shared/themes.js';
import { applyTheme } from '../theme.js';

type SettingsTab = 'reviewers' | 'agents' | 'themes';

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'reviewers', label: 'Reviewers' },
  { id: 'agents', label: 'Agents' },
  { id: 'themes', label: 'Themes' },
];

export function SettingsModal(props: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [tab, setTab] = useState<SettingsTab>('reviewers');

  useEffect(() => {
    window.margin.getSettings().then(setSettings);
  }, []);

  if (!settings) return null;
  const s = settings;

  const save = async () => {
    await window.margin.saveSettings(s);
    props.onClose();
  };

  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <div className="panel-tabs settings-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-body">
        {tab === 'reviewers' && (
        <>
        <p className="modal-note">
          Extra finders run alongside the Claude reviewer on every review; their findings are tagged with
          their source. Different model families catch different things.
        </p>

        <section className="settings-section">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={s.openai.enabled}
              onChange={(e) => setSettings({ ...s, openai: { ...s.openai, enabled: e.target.checked } })}
            />
            OpenAI-compatible model <span className="settings-hint">(OpenAI, Ollama, OpenRouter — sends diff + changed files to the endpoint)</span>
          </label>
          <div className="settings-fields">
            <label>
              Base URL
              <input
                type="text"
                value={s.openai.baseUrl}
                placeholder="https://api.openai.com/v1  ·  http://localhost:11434/v1 for Ollama"
                onChange={(e) => setSettings({ ...s, openai: { ...s.openai, baseUrl: e.target.value } })}
              />
            </label>
            <label>
              API key <span className="settings-hint">(stored locally in settings.json; leave empty for Ollama)</span>
              <input
                type="password"
                value={s.openai.apiKey}
                onChange={(e) => setSettings({ ...s, openai: { ...s.openai, apiKey: e.target.value } })}
              />
            </label>
            <label>
              Model <span className="settings-hint">(comma-separate to run several — each reviews independently)</span>
              <input
                type="text"
                value={s.openai.model}
                placeholder="e.g. gpt-5  ·  qwen2.5-coder, llama3.1 for Ollama"
                onChange={(e) => setSettings({ ...s, openai: { ...s.openai, model: e.target.value } })}
              />
            </label>
          </div>
        </section>

        <section className="settings-section">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={s.coderabbit.enabled}
              onChange={(e) => setSettings({ ...s, coderabbit: { ...s.coderabbit, enabled: e.target.checked } })}
            />
            CodeRabbit <span className="settings-hint">(uses the coderabbit CLI — sends the diff to CodeRabbit's cloud)</span>
          </label>
        </section>

        <section className="settings-section">
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={s.verifier.enabled}
              onChange={(e) => setSettings({ ...s, verifier: { ...s.verifier, enabled: e.target.checked } })}
            />
            Verifier pass <span className="settings-hint">(an agentic Claude session cross-examines every finding against the code; refuted findings are set aside)</span>
          </label>
          <div className="settings-fields">
            <label>
              Verifier model <span className="settings-hint">(empty = same as the session; a strong model here pays off)</span>
              <input
                type="text"
                value={s.verifier.model}
                placeholder="e.g. opus or claude-fable-5"
                onChange={(e) => setSettings({ ...s, verifier: { ...s.verifier, model: e.target.value } })}
              />
            </label>
          </div>
        </section>
        </>
        )}

        {tab === 'agents' && (
        <section className="settings-section">
          <div className="settings-fields">
            <label>
              New comment threads go to{' '}
              <span className="settings-hint">
                (the composer's starting choice — still changeable per thread; handing a thread to your
                own agent spends no AI call)
              </span>
              <select
                value={s.defaultAnswerer}
                onChange={(e) => setSettings({ ...s, defaultAnswerer: e.target.value })}
              >
                <option value={SETTING_REVIEWER}>Margin's reviewer</option>
                {s.agents
                  .filter((a) => a.name.trim())
                  .map((a) => (
                    <option key={a.name} value={a.name.trim()}>
                      @{a.name.trim()}
                    </option>
                  ))}
                <option value={SETTING_MY_AGENT}>↗ my agent (file bridge)</option>
              </select>
            </label>
          </div>
          <div className="settings-toggle">
            Specialist agents <span className="settings-hint">(assignable per comment thread — the reviewer delegates the thread to them; read-only tools)</span>
          </div>
          {s.agents.map((a, i) => (
            <div key={i} className="agent-row">
              <div className="agent-row-head">
                <input
                  type="text"
                  className="agent-name"
                  placeholder="name (e.g. security)"
                  value={a.name}
                  onChange={(e) => setSettings({ ...s, agents: s.agents.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                />
                <select
                  value={a.model ?? ''}
                  onChange={(e) => setSettings({ ...s, agents: s.agents.map((x, j) => (j === i ? { ...x, model: e.target.value || undefined } : x)) })}
                >
                  <option value="">session model</option>
                  <option value="opus">opus</option>
                  <option value="sonnet">sonnet</option>
                  <option value="haiku">haiku</option>
                </select>
                <button
                  className="icon-btn"
                  title="Remove agent"
                  onClick={() => setSettings({ ...s, agents: s.agents.filter((_, j) => j !== i) })}
                >
                  ✕
                </button>
              </div>
              <input
                type="text"
                placeholder="One-line description — when should the reviewer use this agent?"
                value={a.description}
                onChange={(e) => setSettings({ ...s, agents: s.agents.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })}
              />
              <textarea
                placeholder="Instructions — the agent's system prompt"
                value={a.instructions}
                onChange={(e) => setSettings({ ...s, agents: s.agents.map((x, j) => (j === i ? { ...x, instructions: e.target.value } : x)) })}
              />
              <label className="agent-finder">
                <input
                  type="checkbox"
                  checked={!!a.finder}
                  onChange={(e) => setSettings({ ...s, agents: s.agents.map((x, j) => (j === i ? { ...x, finder: e.target.checked || undefined } : x)) })}
                />
                Run as a finder on every review{' '}
                <span className="settings-hint">
                  (own agentic pass over the diff; skips itself when the changeset is outside its specialty)
                </span>
              </label>
              {a.finder && (
                <>
                  <span className="settings-hint">
                    Checks the finder reports on every review, one per line — each comes back
                    pass/finding with evidence, so a clean review still shows what was looked at.
                  </span>
                  <textarea
                    className="agent-rubric"
                    placeholder={'e.g.\nN+1 queries or missing pagination\nblocking I/O on a hot path'}
                    value={a.rubric ?? ''}
                    onChange={(e) => setSettings({ ...s, agents: s.agents.map((x, j) => (j === i ? { ...x, rubric: e.target.value || undefined } : x)) })}
                  />
                </>
              )}
            </div>
          ))}
          <button
            className="icon-btn add-agent"
            onClick={() => setSettings({ ...s, agents: [...s.agents, { name: '', description: '', instructions: '' }] })}
          >
            + Add agent
          </button>
        </section>
        )}

        {tab === 'themes' && <ThemeSection themes={s.themes} onChange={(themes) => setSettings({ ...s, themes })} />}
        </div>

        <div className="modal-actions">
          <button
            className="icon-btn settings-json"
            title="Edit the raw file — unsaved changes in this dialog are not written, and manual edits apply the next time settings are read"
            onClick={() => window.margin.openSettingsFile().catch((err) => window.alert(String(err)))}
          >
            settings.json
          </button>
          <span className="settings-version" title="Margin version">v{__APP_VERSION__}</span>
          <button className="icon-btn" onClick={props.onClose}>Cancel</button>
          <button className="run-btn small" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

function ThemeSection(props: { themes: ThemeSettings; onChange: (themes: ThemeSettings) => void }) {
  const allThemes = [...props.themes.custom, ...PRESET_THEMES];
  const active = resolveTheme(props.themes);
  const customIdx = props.themes.custom.findIndex((t) => t.name === props.themes.active);
  const isCustom = customIdx !== -1;

  // Every change previews live; App reapplies the saved theme on close, so
  // Cancel reverts the preview.
  const setThemes = (themes: ThemeSettings) => {
    props.onChange(themes);
    applyTheme(resolveTheme(themes));
  };

  const updateCustom = (patch: Partial<Theme>) => {
    // Themes are located by name — a rename onto an existing name would make
    // later edits land on the wrong theme, so ignore colliding renames.
    if (patch.name && allThemes.some((t, i) => i !== customIdx && t.name === patch.name)) return;
    const custom = props.themes.custom.map((t, i) => (i === customIdx ? { ...t, ...patch } : t));
    setThemes({ active: patch.name ?? props.themes.active, custom });
  };

  const duplicate = () => {
    let name = `${active.name} copy`;
    for (let n = 2; allThemes.some((t) => t.name === name); n++) name = `${active.name} copy ${n}`;
    setThemes({ active: name, custom: [...props.themes.custom, { ...active, name, colors: { ...active.colors } }] });
  };

  return (
    <section className="settings-section">
      <div className="settings-toggle">
        Theme <span className="settings-hint">(changes preview live — Save to keep, Cancel to revert)</span>
      </div>
      <div className="theme-row">
        <select value={props.themes.active} onChange={(e) => setThemes({ ...props.themes, active: e.target.value })}>
          {props.themes.custom.map((t) => (
            <option key={`c-${t.name}`} value={t.name}>{t.name}</option>
          ))}
          {PRESET_THEMES.map((t) => (
            <option key={`p-${t.name}`} value={t.name}>{t.name} (preset)</option>
          ))}
        </select>
        <button className="icon-btn" title="Copy this theme into an editable custom theme" onClick={duplicate}>
          Duplicate
        </button>
        {isCustom && (
          <button
            className="icon-btn"
            title="Delete this custom theme"
            onClick={() => setThemes({ active: PRESET_THEMES[0].name, custom: props.themes.custom.filter((_, i) => i !== customIdx) })}
          >
            Delete
          </button>
        )}
      </div>
      {isCustom && (
        <>
          <div className="theme-row">
            <input type="text" value={active.name} onChange={(e) => updateCustom({ name: e.target.value })} />
            <select value={active.mode} onChange={(e) => updateCustom({ mode: e.target.value as Theme['mode'] })}>
              <option value="dark">dark</option>
              <option value="light">light</option>
            </select>
          </div>
          <div className="theme-tokens">
            {(Object.keys(THEME_TOKENS) as Array<keyof typeof THEME_TOKENS>).map((key) => (
              <label key={key} className="theme-token">
                <input
                  type="color"
                  value={active.colors[key] ?? PRESET_THEMES[0].colors[key]}
                  onChange={(e) => updateCustom({ colors: { ...active.colors, [key]: e.target.value } })}
                />
                {key}
              </label>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
