// Preload for the notebook window. Receives streaming answers from the main process.

import { contextBridge, ipcRenderer } from 'electron';
import type { ModelFit, DetailedModel, CatalogEntry, ModelsList } from './shared/model-types';
import type { Folder, FolderState } from './services/notebook/folder-store';
import type { AIBlockMeta } from './services/notebook/sidecar';
export type { ModelFit, DetailedModel, CatalogEntry, ModelsList };
export type { Folder, FolderState, AIBlockMeta };

/** A note's body plus the metadata needed to reconstruct its AI blocks on load. */
export interface NoteWithBlocks {
  body: string;
  aiBlocks: AIBlockMeta[];
}

export interface NotebookMeta {
  prompt: string;        // action label (Explain / Debug / …) or freeform question
  selection: string;     // captured text
  sourceApp?: string;
  model: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  snippet: string;
  sourceApp?: string;
  model?: string;
  imagePath?: string;
  pinned: boolean;
  createdAt: string;
}

const api = {
  // Handshake: tell main the notebook view has mounted and is listening, so it can flush
  // any answer that started streaming before the window finished loading.
  signalReady: () => ipcRenderer.send('notebook:ready'),
  // Notes-app operations
  openSettings: () => ipcRenderer.send('open-settings'),
  list: (): Promise<NoteSummary[]> => ipcRenderer.invoke('notebook:list'),
  /** Abort any in-flight inline generation (call on editor unmount). */
  cancelGen: (): Promise<void> => ipcRenderer.invoke('notebook:cancel-gen'),
  /** Re-read notes from disk and return the fresh summaries (call on window focus). */
  resync: (): Promise<NoteSummary[]> => ipcRenderer.invoke('notebook:resync'),
  search: (query: string): Promise<Array<{ id: string; snippet: string; tags: string[] }>> => ipcRenderer.invoke('notebook:search', query),
  getBody: (id: string): Promise<string | null> => ipcRenderer.invoke('notebook:get', id),
  /** Body + AI-block metadata, for reconstructing AI blocks when a note loads. */
  getNote: (id: string): Promise<NoteWithBlocks | null> => ipcRenderer.invoke('notebook:get-note', id),
  /** Data URL of the note's capture image, or null. */
  getImage: (id: string): Promise<string | null> => ipcRenderer.invoke('notebook:image', id),
  rename: (id: string, title: string): Promise<void> => ipcRenderer.invoke('notebook:rename', id, title),
  setPinned: (id: string, pinned: boolean): Promise<void> => ipcRenderer.invoke('notebook:pin', id, pinned),
  /** Persist a note's body; pass `aiBlocks` to also rewrite its AI-block sidecar (omit to leave it). */
  updateBody: (id: string, body: string, aiBlocks?: Array<Omit<AIBlockMeta, 'createdAt'>>): Promise<void> =>
    ipcRenderer.invoke('notebook:update-body', id, body, aiBlocks),
  hide: (id: string): Promise<void> => ipcRenderer.invoke('notebook:hide', id),
  restore: (id: string): Promise<void> => ipcRenderer.invoke('notebook:restore', id),
  remove: (id: string): Promise<void> => ipcRenderer.invoke('notebook:delete', id),
  /** Create an empty note (optionally inside a folder); resolves with the new note id. */
  createNote: (folderId?: string | null): Promise<string | null> => ipcRenderer.invoke('notebook:create', folderId ?? null),

  // ── Folder tree (organization) ──────────────────────────────────────────────────────
  foldersGet: (): Promise<FolderState> => ipcRenderer.invoke('folders:get'),
  createFolder: (name: string, parentId: string | null): Promise<Folder | null> => ipcRenderer.invoke('folders:create', name, parentId ?? null),
  renameFolder: (id: string, name: string): Promise<void> => ipcRenderer.invoke('folders:rename', id, name),
  deleteFolder: (id: string): Promise<void> => ipcRenderer.invoke('folders:delete', id),
  moveNote: (noteId: string, folderId: string | null): Promise<void> => ipcRenderer.invoke('folders:move-note', noteId, folderId ?? null),
  moveFolder: (id: string, parentId: string | null): Promise<void> => ipcRenderer.invoke('folders:move-folder', id, parentId ?? null),

  // ── Custom window controls (native traffic lights hidden) ────────────────────────────
  minimizeWindow: () => ipcRenderer.send('win:minimize'),
  zoomWindow: () => ipcRenderer.send('win:zoom'),
  closeWindow: () => ipcRenderer.send('win:close'),
  /** Fired after a streamed answer is saved (id of the new note). */
  onSaved: (cb: (id: string) => void) => {
    const h = (_e: unknown, id: string) => cb(id);
    ipcRenderer.on('notebook:saved', h);
    return () => ipcRenderer.removeListener('notebook:saved', h);
  },

  /** Main asked to open the in-pane settings view (e.g. from the notch or the app menu). */
  onShowSettings: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('notebook:show-settings', h);
    return () => ipcRenderer.removeListener('notebook:show-settings', h);
  },

  /** A new query started — reset the view with its metadata. */
  onStart: (cb: (meta: NotebookMeta) => void) => {
    const h = (_e: unknown, meta: NotebookMeta) => cb(meta);
    ipcRenderer.on('notebook:start', h);
    return () => ipcRenderer.removeListener('notebook:start', h);
  },
  /** Streaming answer tokens (cumulative string). */
  onToken: (cb: (partial: string) => void) => {
    const h = (_e: unknown, partial: string) => cb(partial);
    ipcRenderer.on('notebook:token', h);
    return () => ipcRenderer.removeListener('notebook:token', h);
  },
  /** Query finished (final answer). */
  onDone: (cb: (answer: string) => void) => {
    const h = (_e: unknown, answer: string) => cb(answer);
    ipcRenderer.on('notebook:done', h);
    return () => ipcRenderer.removeListener('notebook:done', h);
  },
  /** Query errored. */
  onError: (cb: (message: string) => void) => {
    const h = (_e: unknown, message: string) => cb(message);
    ipcRenderer.on('notebook:error', h);
    return () => ipcRenderer.removeListener('notebook:error', h);
  },

  // ---- Inline generation (the `/` command bridge) -------------------------------------
  // The notebook initiates a query that streams INTO a block (by blockId) in the open note,
  // instead of creating a new note. Events are tagged with the target blockId.

  /** Run a slash command / freeform prompt; the answer streams via onGen* tagged with blockId. */
  generate: (req: {
    blockId: string;
    commandId?: string;
    freeText?: string;
    selection?: string;
    userSelectedModel?: string;
  }): Promise<{ ok: boolean; model?: string; answer?: string; error?: string }> =>
    ipcRenderer.invoke('notebook:generate', req),

  onGenStart: (cb: (p: { blockId: string; model: string }) => void) => {
    const h = (_e: unknown, p: { blockId: string; model: string }) => cb(p);
    ipcRenderer.on('notebook:gen-start', h);
    return () => ipcRenderer.removeListener('notebook:gen-start', h);
  },
  /** A streaming chunk (delta, not cumulative) for a specific block. */
  onGenToken: (cb: (p: { blockId: string; delta: string }) => void) => {
    const h = (_e: unknown, p: { blockId: string; delta: string }) => cb(p);
    ipcRenderer.on('notebook:gen-token', h);
    return () => ipcRenderer.removeListener('notebook:gen-token', h);
  },
  onGenDone: (cb: (p: { blockId: string; answer: string; model: string }) => void) => {
    const h = (_e: unknown, p: { blockId: string; answer: string; model: string }) => cb(p);
    ipcRenderer.on('notebook:gen-done', h);
    return () => ipcRenderer.removeListener('notebook:gen-done', h);
  },
  onGenError: (cb: (p: { blockId: string; message: string }) => void) => {
    const h = (_e: unknown, p: { blockId: string; message: string }) => cb(p);
    ipcRenderer.on('notebook:gen-error', h);
    return () => ipcRenderer.removeListener('notebook:gen-error', h);
  },
};

contextBridge.exposeInMainWorld('notebookAPI', api);
export type NotebookAPI = typeof api;

// Settings now lives in the notebook's right pane (no separate window), so the
// notebook window needs the same settings bridge the standalone settings window has.
const settingsApi = {
  get: (): Promise<{ openaiKeySet: boolean; anthropicKeySet: boolean; defaultTextModel?: string; defaultVisionModel?: string; notchEnabled: boolean }> => ipcRenderer.invoke('settings:get'),
  setKey: (provider: 'openai' | 'anthropic', key: string): Promise<void> => ipcRenderer.invoke('settings:set-key', provider, key),
  setNotchEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke('settings:set-notch', enabled),
  listModels: (): Promise<string[]> => ipcRenderer.invoke('panel:models'),
  pullModel: (name: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('ollama:pull', name),
  onPullProgress: (cb: (p: { name: string; status: string; percent: number }) => void) => {
    const h = (_e: unknown, p: { name: string; status: string; percent: number }) => cb(p);
    ipcRenderer.on('settings:pull-progress', h);
    return () => ipcRenderer.removeListener('settings:pull-progress', h);
  },
  // Models page
  listModelsDetailed: (): Promise<ModelsList> => ipcRenderer.invoke('models:list-detailed'),
  modelCatalog: (): Promise<CatalogEntry[]> => ipcRenderer.invoke('models:catalog'),
  deleteModel: (name: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('models:delete', name),
  setDefaultModel: (kind: 'text' | 'vision', model: string): Promise<void> => ipcRenderer.invoke('models:set-default', kind, model),
};
contextBridge.exposeInMainWorld('settingsAPI', settingsApi);
