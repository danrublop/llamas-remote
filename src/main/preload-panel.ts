// Preload for the notch panel renderer. Exposes a small, purpose-built bridge
// (window.llamasAPI) rather than the legacy explanation preload.

import { contextBridge, ipcRenderer } from 'electron';

export interface PanelQueryRequest {
  kind: 'text' | 'image';
  presetId?: string;
  freeText?: string;
  /** Pre-captured selection (sent by main when the hotkey fires). */
  selection?: string;
  sourceApp?: string;
  imagePath?: string;
  /** Model the user picked in the panel. */
  userSelectedModel?: string;
  /** Absolute paths of files the user attached. */
  attachments?: string[];
  /** Auto-open the notebook when done (default true). */
  autoOpen?: boolean;
}

export interface PanelQueryResult {
  ok: boolean;
  answer?: string;
  model?: string;
  entryId?: string;
  error?: string;
}

export interface PanelCaptured {
  selection: string;
  sourceApp?: string;
  /** true when capture failed and the user should paste/type instead. */
  empty: boolean;
  /** present when capture errored (e.g. missing Accessibility permission). */
  error?: string;
}

const api = {
  /** Run a query end to end (the answer streams into the notebook window, not here). */
  runQuery: (req: PanelQueryRequest): Promise<PanelQueryResult> => ipcRenderer.invoke('panel:run-query', req),
  /** Trigger interactive region screenshot; returns the saved path or null (cancel). */
  captureScreenshot: (): Promise<string | null> => ipcRenderer.invoke('panel:screenshot'),
  /** Grab text from a screen region via on-device OCR (no model). Returns recognized text. */
  ocrCapture: (): Promise<{ text: string; cancelled?: boolean; error?: string }> => ipcRenderer.invoke('panel:ocr'),
  /** List installed local models for the picker. */
  listModels: (): Promise<string[]> => ipcRenderer.invoke('panel:models'),
  /** The user's saved default models (set on the Models page). */
  getDefaults: (): Promise<{ text?: string; vision?: string }> => ipcRenderer.invoke('panel:defaults'),
  /** Persist the panel's model pick as the default so the Models page stays in sync. */
  setDefaultModel: (kind: 'text' | 'vision', model: string): Promise<void> => ipcRenderer.invoke('models:set-default', kind, model),
  /** Open a native file picker; returns the chosen files' paths + display names. */
  pickFiles: (): Promise<Array<{ path: string; name: string }>> => ipcRenderer.invoke('panel:pick-files'),
  /** Open the notebook window now (watch the answer stream in). */
  openNotebook: () => ipcRenderer.send('open-notebook'),
  /** Open the settings window (pull models, add cloud keys). */
  openSettings: () => ipcRenderer.send('open-settings'),
  /** Capture the current selection on demand (used when the panel opens via hover). */
  requestCapture: (): Promise<{ selection: string; sourceApp?: string; empty: boolean; error?: string }> => ipcRenderer.invoke('panel:capture'),
  /** Collapse the panel back to the idle island. */
  close: () => ipcRenderer.send('panel:close'),
  /** Toggle whether the window captures mouse events (true) or is click-through (false). */
  setInteractive: (on: boolean) => ipcRenderer.send('panel:set-interactive', on),
  /** Take keyboard focus (so Esc / window-blur dismissal become live). Called when the
   *  panel runs an action from a hover-open, which never grabbed focus on its own. */
  focus: () => ipcRenderer.send('panel:focus'),

  /** Fired when the hotkey captured a selection (prefill the panel). */
  onCaptured: (cb: (data: PanelCaptured) => void) => {
    const h = (_e: unknown, data: PanelCaptured) => cb(data);
    ipcRenderer.on('panel:captured', h);
    return () => ipcRenderer.removeListener('panel:captured', h);
  },
  /** Main asks the panel to expand (hotkey/tray). */
  onExpand: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('panel:expand', h);
    return () => ipcRenderer.removeListener('panel:expand', h);
  },
  /** Main asks the panel to collapse to the idle island (blur). */
  onCollapse: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('panel:collapse', h);
    return () => ipcRenderer.removeListener('panel:collapse', h);
  },
};

contextBridge.exposeInMainWorld('llamasAPI', api);

export type LlamasAPI = typeof api;
