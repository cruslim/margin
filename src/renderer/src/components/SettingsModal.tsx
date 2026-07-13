import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/ipc.js';

export function SettingsModal(props: { onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);

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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Additional reviewers</h2>
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
              Model
              <input
                type="text"
                value={s.openai.model}
                placeholder="e.g. gpt-5  ·  qwen2.5-coder for Ollama"
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

        <div className="modal-actions">
          <button className="icon-btn" onClick={props.onClose}>Cancel</button>
          <button className="run-btn small" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
