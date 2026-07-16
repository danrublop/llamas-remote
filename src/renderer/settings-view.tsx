import React, { useEffect, useState } from 'react';
import './settings.css';
// Shared IPC DTOs (single definition under src/main/shared; type-only import, erased at
// build time so the renderer gains no runtime dependency on main).
import type { ModelFit, DetailedModel, CatalogEntry, ModelsList } from '../main/shared/model-types';
export type { ModelFit, DetailedModel, CatalogEntry, ModelsList };

interface SettingsAPI {
  get: () => Promise<{ openaiKeySet: boolean; anthropicKeySet: boolean; defaultTextModel?: string; defaultVisionModel?: string; notchEnabled: boolean }>;
  setKey: (provider: 'openai' | 'anthropic', key: string) => Promise<void>;
  setNotchEnabled: (enabled: boolean) => Promise<void>;
  listModels: () => Promise<string[]>;
  pullModel: (name: string) => Promise<{ ok: boolean; error?: string }>;
  onPullProgress: (cb: (p: { name: string; status: string; percent: number }) => void) => () => void;
  listModelsDetailed: () => Promise<ModelsList>;
  modelCatalog: () => Promise<CatalogEntry[]>;
  deleteModel: (name: string) => Promise<{ ok: boolean; error?: string }>;
  setDefaultModel: (kind: 'text' | 'vision', model: string) => Promise<void>;
}
declare global { interface Window { settingsAPI: SettingsAPI } }

/** The Settings UI. Reused by the standalone settings window (showDrag) and the
    notebook's in-pane settings view. Talks to window.settingsAPI, which both the
    settings and notebook preloads expose. */
export function SettingsView({ showDrag = false, hideModels = false }: { showDrag?: boolean; hideModels?: boolean }) {
  const [openaiSet, setOpenaiSet] = useState(false);
  const [anthropicSet, setAnthropicSet] = useState(false);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [pullName, setPullName] = useState('');
  const [pulling, setPulling] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [notchOn, setNotchOn] = useState(true);

  const refreshModels = () => window.settingsAPI.listModels().then(setModels).catch(() => {});

  function toggleNotch(on: boolean) {
    setNotchOn(on);
    window.settingsAPI.setNotchEnabled(on).catch(() => {});
  }

  useEffect(() => {
    window.settingsAPI.get().then((s) => { setOpenaiSet(s.openaiKeySet); setAnthropicSet(s.anthropicKeySet); setNotchOn(s.notchEnabled); });
    refreshModels();
    const off = window.settingsAPI.onPullProgress((p) => setProgress(`${p.status} ${p.percent ? p.percent + '%' : ''}`.trim()));
    return off;
  }, []);

  async function saveKey(provider: 'openai' | 'anthropic') {
    const key = provider === 'openai' ? openaiKey : anthropicKey;
    await window.settingsAPI.setKey(provider, key);
    const s = await window.settingsAPI.get();
    setOpenaiSet(s.openaiKeySet); setAnthropicSet(s.anthropicKeySet);
    if (provider === 'openai') setOpenaiKey(''); else setAnthropicKey('');
    refreshModels();
  }

  async function pull() {
    if (!pullName.trim()) return;
    setError(''); setPulling(true); setProgress('starting…');
    const res = await window.settingsAPI.pullModel(pullName.trim());
    setPulling(false);
    if (res.ok) { setProgress('done ✓'); setPullName(''); refreshModels(); }
    else { setError(res.error ?? 'Pull failed'); setProgress(''); }
  }

  const localModels = models.filter((m) => !m.includes('/'));

  return (
    <div className="wrap">
      {showDrag && <div className="drag" />}
      <header className="settings-head"><h1>Settings</h1></header>

      <div className="section">
        <h2>Notch</h2>
        <div className="switch-row">
          <span className="switch-text">
            <span className="switch-title">Dynamic-Island notch</span>
            <span className="hint">Show the notch panel and enable ⌘⇧Space to capture text and ask. Turn off to hide it — the menu-bar icon stays.</span>
          </span>
          <button role="switch" aria-checked={notchOn} className={`switch${notchOn ? ' on' : ''}`} onClick={() => toggleNotch(!notchOn)} title={notchOn ? 'Turn notch off' : 'Turn notch on'}>
            <span className="switch-knob" />
          </button>
        </div>
      </div>

      {!hideModels && (
      <div className="section">
        <h2>Local models (Ollama)</h2>
        <div className="models">
          {localModels.length === 0 && <span className="hint">No local models yet — pull one below.</span>}
          {localModels.map((m) => <span key={m} className="chip">{m}</span>)}
        </div>
        <div className="row">
          <input placeholder="model to pull (e.g. llama3.2, qwen2.5, llava)" value={pullName} onChange={(e) => setPullName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') pull(); }} />
          <button className="btn primary" onClick={pull} disabled={pulling}>{pulling ? 'Pulling…' : 'Pull'}</button>
        </div>
        {progress && <div className="progress">{progress}</div>}
        {error && <div className="err">{error}</div>}
      </div>
      )}

      <div className="section">
        <h2>OpenAI</h2>
        {openaiSet && <span className="set">✓ API key saved</span>}
        <div className="row">
          <input type="password" placeholder="sk-…" value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} />
          <button className="btn" onClick={() => saveKey('openai')}>Save</button>
        </div>
        <span className="hint">Adds gpt-4o / gpt-4o-mini to the model picker.</span>
      </div>

      <div className="section">
        <h2>Anthropic (Claude)</h2>
        {anthropicSet && <span className="set">✓ API key saved</span>}
        <div className="row">
          <input type="password" placeholder="sk-ant-…" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} />
          <button className="btn" onClick={() => saveKey('anthropic')}>Save</button>
        </div>
        <span className="hint">Adds Claude Sonnet / Haiku to the model picker.</span>
      </div>

      <span className="hint">Keys are encrypted on this machine via your OS keychain (Electron safeStorage) and never leave it except to call the provider you choose. Cloud models are text-only.</span>
    </div>
  );
}
