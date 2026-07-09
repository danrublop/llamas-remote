import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { BrandIcon } from './model-icon';
import { SettingsView } from './settings-view';
import { ModelsView } from './models-view';
import { NotebookEditor } from './editor/NotebookEditor';
import type { Editor } from '@tiptap/react';
import './notebook.css';

interface NotebookMeta { prompt: string; selection: string; sourceApp?: string; model: string }
interface NoteSummary { id: string; title: string; snippet: string; sourceApp?: string; model?: string; imagePath?: string; pinned: boolean; createdAt: string }
interface AIBlockMeta { blockId: string; prompt: string; model: string; commandId?: string; selection?: string; createdAt: string }
interface NoteWithBlocks { body: string; aiBlocks: AIBlockMeta[] }
interface Folder { id: string; name: string; parentId: string | null }
interface FolderState { folders: Folder[]; assignments: Record<string, string> }
interface NotebookAPI {
  openSettings: () => void;
  list: () => Promise<NoteSummary[]>;
  resync: () => Promise<NoteSummary[]>; // syncFromDisk in main → fresh summaries (external-edit pickup)
  cancelGen: () => Promise<void>;       // abort all in-flight inline AI-block generations
  search: (query: string) => Promise<Array<{ id: string; snippet: string; tags: string[] }>>;
  getBody: (id: string) => Promise<string | null>;
  getNote: (id: string) => Promise<NoteWithBlocks | null>;
  getImage: (id: string) => Promise<string | null>;
  rename: (id: string, title: string) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  updateBody: (id: string, body: string, aiBlocks?: Array<Omit<AIBlockMeta, 'createdAt'>>) => Promise<void>;
  hide: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  createNote: (folderId?: string | null) => Promise<string | null>;
  foldersGet: () => Promise<FolderState>;
  createFolder: (name: string, parentId: string | null) => Promise<Folder | null>;
  renameFolder: (id: string, name: string) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;
  moveNote: (noteId: string, folderId: string | null) => Promise<void>;
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
  minimizeWindow: () => void;
  zoomWindow: () => void;
  closeWindow: () => void;
  signalReady: () => void;
  onShowSettings: (cb: () => void) => () => void;
  onSaved: (cb: (id: string) => void) => () => void;
  onStart: (cb: (meta: NotebookMeta) => void) => () => void;
  onToken: (cb: (delta: string) => void) => () => void;
  onDone: (cb: (answer: string) => void) => () => void;
  onError: (cb: (message: string) => void) => () => void;
}
declare global { interface Window { notebookAPI: NotebookAPI } }

const FONTS = [
  // Sans-serif
  'Inter', 'system-ui', 'Helvetica Neue', 'Arial', 'Avenir', 'Avenir Next',
  'Futura', 'Gill Sans', 'Optima', 'Verdana', 'Trebuchet MS', 'Tahoma', 'Geneva',
  // Serif
  'Georgia', 'Charter', 'Iowan Old Style', 'Palatino', 'Baskerville',
  'Times New Roman', 'Hoefler Text', 'Didot', 'Cochin', 'Big Caslon', 'Athelas',
  // Slab / typewriter
  'American Typewriter', 'Rockwell', 'Courier New',
  // Monospace
  'Menlo', 'Monaco', 'SF Mono', 'JetBrains Mono', 'Andale Mono',
  // Display / handwriting
  'Impact', 'Copperplate', 'Comic Sans MS', 'Bradley Hand', 'Marker Felt',
  'Chalkboard SE', 'Noteworthy', 'Snell Roundhand', 'Papyrus',
];
const SIZES = ['12', '14', '16', '18', '20', '24', '28', '32'];

// Monochrome line icons (currentColor) for a consistent toolbar — no emoji.
const Ico = {
  pin: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M14.4 2.6a1 1 0 0 0-1.4 0l-.7.7a1 1 0 0 0-.1 1.3l.2.3-3.9 3.9-2.8.5a1 1 0 0 0-.5 1.7l3 3L4 21l4.8-4 3 3a1 1 0 0 0 1.7-.5l.5-2.8 3.9-3.9.3.2a1 1 0 0 0 1.3-.1l.7-.7a1 1 0 0 0 0-1.4z" /></svg>,
  trash: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>,
  copy: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>,
  download: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>,
  chevron: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 6 15 12 9 18" /></svg>,
  folder: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>,
  note: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h8l4 4v14a0 0 0 0 1 0 0H6a0 0 0 0 1 0 0z" /><polyline points="14 3 14 7 18 7" /></svg>,
  addNote: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" /><polyline points="13 3 13 8 18 8" /><line x1="18" y1="14" x2="18" y2="20" /><line x1="15" y1="17" x2="21" y2="17" /></svg>,
  addFolder: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><line x1="12" y1="10" x2="12" y2="16" /><line x1="9" y1="13" x2="15" y2="13" /></svg>,
  sidebar: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>,
  search: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
  code: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>,
  highlight: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l-4 4v3h3l4-4" /><path d="M13 7l4 4" /><path d="M20.5 6.5a2.1 2.1 0 0 0-3-3L9 12l3 3z" /></svg>,
  moon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>,
  sun: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" /><line x1="4.2" y1="4.2" x2="5.6" y2="5.6" /><line x1="18.4" y1="18.4" x2="19.8" y2="19.8" /><line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" /><line x1="4.2" y1="19.8" x2="5.6" y2="18.4" /><line x1="18.4" y1="5.6" x2="19.8" y2="4.2" /></svg>,
};

// Languages offered by the code-block dropdown (all bundled in lowlight's `common`).
const CODE_LANGS: Array<{ id: string; label: string }> = [
  { id: 'java', label: 'Java' }, { id: 'javascript', label: 'JavaScript' }, { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' }, { id: 'c', label: 'C' }, { id: 'cpp', label: 'C++' }, { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' }, { id: 'rust', label: 'Rust' }, { id: 'ruby', label: 'Ruby' }, { id: 'php', label: 'PHP' },
  { id: 'swift', label: 'Swift' }, { id: 'kotlin', label: 'Kotlin' }, { id: 'sql', label: 'SQL' }, { id: 'bash', label: 'Shell' },
  { id: 'json', label: 'JSON' }, { id: 'xml', label: 'HTML/XML' }, { id: 'css', label: 'CSS' }, { id: 'plaintext', label: 'Plain' },
];

const countWords = (text: string): number => {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
};

const EXPANDED_KEY = 'nb-expanded';
const loadExpanded = (): Set<string> => {
  try { const a = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'); return new Set(Array.isArray(a) ? a : []); }
  catch { return new Set(); }
};

function Notebook() {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('nb-sidebar') !== 'closed');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const v = parseInt(localStorage.getItem('nb-sidebar-w') || '', 10);
    return Number.isFinite(v) && v >= 200 && v <= 520 ? v : 300;
  });
  const widthRef = useRef(sidebarWidth);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null); // folder id or '__root__'
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [streaming, setStreaming] = useState<'idle' | 'streaming' | 'error'>('idle');
  const [streamErr, setStreamErr] = useState('');
  const [font, setFont] = useState(localStorage.getItem('nb-font') || 'Inter');
  const [size, setSize] = useState(localStorage.getItem('nb-size') || '16');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NoteSummary[] | null>(null); // null = not searching
  const [searchOpen, setSearchOpen] = useState(false); // search modal
  const [actionTarget, setActionTarget] = useState<{ kind: 'note'; note: NoteSummary } | { kind: 'folder'; folder: Folder } | null>(null); // left-click actions modal
  const [createOpen, setCreateOpen] = useState(false); // "create note/folder" modal (empty-sidebar two-finger click)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 }); // where the last context menu opened
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('nb-theme') === 'dark' ? 'dark' : 'light'));
  const [view, setView] = useState<'notes' | 'settings'>('notes'); // right pane: editor / combined settings
  const [image, setImage] = useState<string | null>(null); // capture data URL for the selected note
  const [words, setWords] = useState(0); // live word count
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);

  // Markdown + AI-block metadata that seed the TipTap editor for the selected/new note.
  // editorKey forces a remount (and re-seed) whenever the note changes — useEditor only reads
  // `content` once.
  const [editorMarkdown, setEditorMarkdown] = useState('');
  const [editorBlocks, setEditorBlocks] = useState<AIBlockMeta[]>([]);
  const [editorKey, setEditorKey] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null); // live TipTap instance (for color/code toolbar)
  const [textColor, setTextColor] = useState('#26251e');
  const [hlColor, setHlColor] = useState('#ffe37a');
  const [codeLang, setCodeLang] = useState('java');
  const liveMarkdown = useRef(''); // latest editor markdown, for copy/export/word count

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDelete = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRename = useRef<{ id: string; title: string } | null>(null);
  const streamRef = useRef<HTMLDivElement>(null); // read-only pane for a streaming notch answer
  const searchRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  selectedRef.current = selectedId;

  // --- streaming notch answer (read-only pane) ----------------------------------------
  const setStream = (text: string) => { if (streamRef.current) streamRef.current.textContent = text; setWords(countWords(text)); };
  const appendStream = (delta: string) => {
    if (!streamRef.current) return;
    streamRef.current.appendChild(document.createTextNode(delta));
  };

  const refresh = useCallback(async () => setNotes(await window.notebookAPI.list()), []);

  // Persist any pending title rename now (debounce timer, note switch, or unmount), keyed to the
  // note it came from. Same 400ms idiom as NotebookEditor.onUpdate — rename does a full file
  // rewrite + FTS reindex + sidebar refresh, so we don't fire it per keystroke.
  const flushRename = useCallback(() => {
    if (renameTimer.current) { clearTimeout(renameTimer.current); renameTimer.current = null; }
    const p = pendingRename.current;
    if (!p) return;
    pendingRename.current = null;
    window.notebookAPI.rename(p.id, p.title).then(refresh).catch(() => {});
  }, [refresh]);

  const refreshFolders = useCallback(async () => {
    const st = await window.notebookAPI.foldersGet();
    setFolders(st.folders);
    setAssignments(st.assignments);
  }, []);

  // Functional updater so back-to-back calls compose (e.g. newFolder expands the parent AND the
  // new child in the same tick — a value-based update would clobber the first with the second).
  const persistExpanded = useCallback((update: (prev: Set<string>) => Set<string>) => {
    setExpanded((prev) => {
      const next = update(prev);
      try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const toggleFolder = useCallback((id: string) => {
    persistExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, [persistExpanded]);
  const expandFolder = useCallback((id: string) => {
    persistExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, [persistExpanded]);

  // Seed the TipTap editor with a note's markdown body + AI-block metadata (remount via editorKey).
  const loadEditor = useCallback((markdown: string, blocks: AIBlockMeta[] = []) => {
    liveMarkdown.current = markdown;
    setEditorMarkdown(markdown);
    setEditorBlocks(blocks);
    setWords(countWords(markdown));
    setEditorKey((k) => k + 1);
  }, []);

  const selectNote = useCallback(async (id: string, fromList?: NoteSummary[]) => {
    flushRename(); // commit any pending rename to the OUTGOING note before we switch away
    streamingRef.current = false;
    setStreaming('idle');
    setView('notes');
    setSelectedId(id);
    selectedRef.current = id; // keep the ref in lockstep so the async load can detect re-selection
    const list = fromList ?? notes;
    setTitle(list.find((n) => n.id === id)?.title ?? '');
    setImage(null);
    const [note, img] = await Promise.all([
      window.notebookAPI.getNote(id),
      window.notebookAPI.getImage(id),
    ]);
    if (selectedRef.current !== id) return; // selection changed while loading
    loadEditor(note?.body ?? '', note?.aiBlocks ?? []);
    setImage(img);
  }, [notes, loadEditor, flushRename]);

  useEffect(() => {
    (async () => {
      const [list] = await Promise.all([window.notebookAPI.list(), refreshFolders()]);
      setNotes(list);
      if (list.length) selectNote(list[0].id, list);
    })();
    const offStart = window.notebookAPI.onStart((m) => {
      streamingRef.current = true;
      setStreaming('streaming'); setStreamErr('');
      setView('notes');
      setSelectedId(null);
      selectedRef.current = null;
      setTitle(m.prompt);
      setImage(null);
      setStream('');
    });
    // onToken carries the new chunk (delta) for the streaming notch answer — append it.
    const offToken = window.notebookAPI.onToken((p) => { if (streamingRef.current) appendStream(p); });
    // onDone carries the full answer; replace the accumulated deltas (corrects any dropped chunk).
    const offDone = window.notebookAPI.onDone((a) => { if (streamingRef.current) setStream(a); });
    const offErr = window.notebookAPI.onError((msg) => { streamingRef.current = false; setStreaming('error'); setStreamErr(msg); });
    const offSaved = window.notebookAPI.onSaved(async (id) => {
      streamingRef.current = false; setStreaming('idle');
      const list = await window.notebookAPI.list();
      setNotes(list);
      selectNote(id, list); // load the freshly-saved note into the editor
    });
    const offSettings = window.notebookAPI.onShowSettings(() => setView('settings'));
    // Listeners are attached — tell main to flush any answer buffered while we loaded.
    window.notebookAPI.signalReady();
    return () => { offStart(); offToken(); offDone(); offErr(); offSaved(); offSettings(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts: ⌘N new note, ⌘F focus search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'n') { e.preventDefault(); newNote(); }
      else if (k === 'f') { e.preventDefault(); setView('notes'); setSearchOpen(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (renamingFolder) { renameRef.current?.focus(); renameRef.current?.select(); } }, [renamingFolder]);

  function onTitleChange(v: string) {
    setTitle(v); // immediate: the input is controlled
    if (!selectedId) return;
    pendingRename.current = { id: selectedId, title: v };
    if (renameTimer.current) clearTimeout(renameTimer.current);
    renameTimer.current = setTimeout(flushRename, 400);
  }

  const closeActions = () => setActionTarget(null);
  // Position a context menu at the click point, nudged in from the viewport edges so it never clips.
  const menuStyle = (h: number): React.CSSProperties => ({
    position: 'fixed',
    left: Math.max(8, Math.min(menuPos.x, window.innerWidth - 268)),
    top: Math.max(8, Math.min(menuPos.y, window.innerHeight - h - 8)),
  });

  function togglePin(n: NoteSummary) {
    window.notebookAPI.setPinned(n.id, !n.pinned).then(refresh).catch(() => {});
  }

  // Commit any pending (toast-window) delete for real — removes the file.
  const commitDelete = useCallback(() => {
    const p = pendingDelete.current;
    if (!p) return;
    clearTimeout(p.timer);
    pendingDelete.current = null;
    window.notebookAPI.remove(p.id).catch(() => {});
  }, []);

  // Finalize a pending (toast-window) delete if the window closes before the timer fires.
  useEffect(() => commitDelete, [commitDelete]);

  // Flush a pending title rename if the window closes before its debounce fires.
  useEffect(() => flushRename, [flushRename]);

  // External edits to the on-disk .md files aren't noticed until relaunch — re-sync from disk on
  // window focus so returning to the app picks them up. Debounced, and skipped while a notch
  // answer is streaming so we don't fight an in-progress write.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => {
      if (streamingRef.current) return;
      if (t) clearTimeout(t);
      t = setTimeout(async () => {
        try { setNotes(await window.notebookAPI.resync()); } catch { /* ignore */ }
      }, 250);
    };
    window.addEventListener('focus', onFocus);
    return () => { if (t) clearTimeout(t); window.removeEventListener('focus', onFocus); };
  }, []);

  // Brief auto-dismissing status toast (no Undo button).
  const showInfo = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg });
    toastTimer.current = setTimeout(() => setToast(null), 2400);
  }, []);

  function noteAsMarkdown(): string {
    return (title.trim() ? `# ${title.trim()}\n\n` : '') + liveMarkdown.current;
  }

  async function copyNote() {
    try { await navigator.clipboard.writeText(noteAsMarkdown()); showInfo('Copied as Markdown'); }
    catch { showInfo('Copy failed'); }
  }

  function exportNote() {
    const md = noteAsMarkdown();
    const blob = new Blob([md + '\n'], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title.trim() || 'note').replace(/[^\w.-]+/g, '-').slice(0, 60)}.md`;
    a.click();
    URL.revokeObjectURL(url);
    showInfo('Exported Markdown');
  }

  async function deleteNote(n: NoteSummary) {
    commitDelete(); // finalize any earlier delete before starting a new one
    await window.notebookAPI.hide(n.id).catch(() => {}); // reversible: file stays on disk
    setNotes((ns) => ns.filter((x) => x.id !== n.id));
    setResults((r) => (r ? r.filter((x) => x.id !== n.id) : r));
    if (selectedRef.current === n.id) {
      const rest = notes.filter((x) => x.id !== n.id);
      if (rest.length) selectNote(rest[0].id, rest); else newNote();
    }
    const timer = setTimeout(() => { setToast(null); commitDelete(); }, 6000);
    pendingDelete.current = { id: n.id, timer };
    setToast({
      msg: `Deleted “${n.title || 'Untitled'}”`,
      undo: async () => {
        const p = pendingDelete.current;
        if (p) { clearTimeout(p.timer); pendingDelete.current = null; }
        await window.notebookAPI.restore(n.id).catch(() => {});
        setNotes(await window.notebookAPI.list());
        setToast(null);
      },
    });
  }

  // The editor changed (debounced/flushed inside NotebookEditor). `id` is the note the editor
  // itself holds — persist to THAT note even if the user has since selected another (a late
  // debounce or an unmount flush must never land in the newly-selected note). Only refresh the
  // live copy (copy/export + word count) when the write is for the note still on screen, so a
  // flush for the outgoing note can't clobber the incoming note's stats.
  const onEditorChange = useCallback((id: string | null, markdown: string, aiBlocks: Array<Omit<AIBlockMeta, 'createdAt'>>) => {
    if (id === selectedRef.current) {
      liveMarkdown.current = markdown;
      setWords(countWords(markdown));
    }
    if (id) {
      window.notebookAPI.updateBody(id, markdown, aiBlocks).then(refresh).catch(() => {});
    }
  }, [refresh]);

  function applyFont(f: string) { setFont(f); localStorage.setItem('nb-font', f); }
  function applySize(s: string) { setSize(s); localStorage.setItem('nb-size', s); }
  function applyColor(hex: string) { setTextColor(hex); editor?.chain().focus().setColor(hex).run(); }
  function toggleHighlight() { editor?.chain().focus().toggleHighlight({ color: hlColor }).run(); }
  function applyHlColor(hex: string) { setHlColor(hex); editor?.chain().focus().setHighlight({ color: hex }).run(); }
  function toggleCode() { editor?.chain().focus().toggleCodeBlock().updateAttributes('codeBlock', { language: codeLang }).run(); }
  function applyCodeLang(lang: string) { setCodeLang(lang); editor?.chain().focus().updateAttributes('codeBlock', { language: lang }).run(); }

  function closeSearch() { setSearchOpen(false); setQuery(''); setResults(null); }

  function onSearch(q: string) {
    setQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) { setResults(null); return; }
    searchTimer.current = setTimeout(async () => {
      const hits = await window.notebookAPI.search(q);
      // Map FTS hits to sidebar rows, pulling titles from the loaded list where available.
      const byId = new Map(notes.map((n) => [n.id, n]));
      setResults(hits.map((h) => {
        const n = byId.get(h.id);
        return { id: h.id, title: n?.title ?? h.snippet, snippet: h.snippet, sourceApp: n?.sourceApp, model: n?.model, pinned: n?.pinned ?? false, createdAt: n?.createdAt ?? '' };
      }));
    }, 180);
  }

  // --- creation --------------------------------------------------------------------------
  // New note (optionally inside a folder). Persists immediately so the note can live in the
  // tree, then loads it into the editor.
  async function newNote(folderId: string | null = null) {
    streamingRef.current = false; setStreaming('idle');
    setView('notes');
    const id = await window.notebookAPI.createNote(folderId).catch(() => null);
    await refreshFolders();
    const list = await window.notebookAPI.list();
    setNotes(list);
    if (folderId) expandFolder(folderId);
    if (id) selectNote(id, list);
    else { setSelectedId(null); selectedRef.current = null; setTitle(''); loadEditor(''); }
  }

  async function newFolder(parentId: string | null = null) {
    const f = await window.notebookAPI.createFolder('New Folder', parentId).catch(() => null);
    if (parentId) expandFolder(parentId);
    await refreshFolders();
    if (f) { expandFolder(f.id); setRenamingFolder(f.id); }
  }

  async function commitRename(id: string, name: string) {
    setRenamingFolder(null);
    await window.notebookAPI.renameFolder(id, name).catch(() => {});
    refreshFolders();
  }

  async function deleteFolder(f: Folder) {
    await window.notebookAPI.deleteFolder(f.id).catch(() => {});
    await refreshFolders();
    showInfo(`Folder “${f.name}” removed — its notes moved up`);
  }

  // --- drag & drop (move notes / folders between folders) --------------------------------
  function onDropInto(folderId: string | null) {
    return async (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      setDropTarget(null);
      const data = e.dataTransfer.getData('text/plain');
      if (data.startsWith('note:')) {
        await window.notebookAPI.moveNote(data.slice(5), folderId).catch(() => {});
      } else if (data.startsWith('folder:')) {
        const fid = data.slice(7);
        if (fid !== folderId) await window.notebookAPI.moveFolder(fid, folderId).catch(() => {});
      }
      if (folderId) expandFolder(folderId);
      refreshFolders();
    };
  }
  const allowDrop = (key: string) => (e: React.DragEvent) => { e.preventDefault(); setDropTarget(key); };

  // --- tree rendering --------------------------------------------------------------------
  const sortedNotes = (arr: NoteSummary[]) => arr; // index already returns pinned-first, newest
  const notesInFolder = (folderId: string | null) =>
    sortedNotes(notes.filter((n) => (assignments[n.id] ?? null) === folderId));
  const childFolders = (parentId: string | null) =>
    folders.filter((f) => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));
  const noteCount = (folderId: string): number => {
    let c = notesInFolder(folderId).length;
    for (const sub of childFolders(folderId)) c += noteCount(sub.id);
    return c;
  };

  const renderNoteRow = (n: NoteSummary, depth: number) => (
    <div
      key={n.id}
      className={`note-row${selectedId === n.id ? ' selected' : ''}`}
      style={{ paddingLeft: 9 + depth * 15 }}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', `note:${n.id}`); e.dataTransfer.effectAllowed = 'move'; }}
      onClick={() => selectNote(n.id)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenuPos({ x: e.clientX, y: e.clientY }); setActionTarget({ kind: 'note', note: n }); }}
    >
      <span className="row-icon">{n.pinned ? Ico.pin : n.model ? <BrandIcon model={n.model} size={16} /> : Ico.note}</span>
      <div className="body">
        <div className="title">{n.title || 'Untitled'}</div>
        <div className="meta">{n.createdAt && relTime(n.createdAt) ? `${relTime(n.createdAt)} · ` : ''}{n.snippet}</div>
      </div>
    </div>
  );

  const renderFolder = (f: Folder, depth: number): React.ReactNode => {
    const isOpen = expanded.has(f.id);
    const kids = childFolders(f.id);
    const rows = notesInFolder(f.id);
    return (
      <div key={f.id} className="tree-folder">
        <div
          className={`folder-row${dropTarget === f.id ? ' drop-target' : ''}`}
          style={{ paddingLeft: 9 + depth * 15 }}
          draggable={renamingFolder !== f.id}
          onDragStart={(e) => { e.dataTransfer.setData('text/plain', `folder:${f.id}`); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={allowDrop(f.id)}
          onDragLeave={() => setDropTarget((t) => (t === f.id ? null : t))}
          onDrop={onDropInto(f.id)}
          onClick={() => toggleFolder(f.id)}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenuPos({ x: e.clientX, y: e.clientY }); setActionTarget({ kind: 'folder', folder: f }); }}
        >
          <span className="folder-ico">{Ico.folder}</span>
          {renamingFolder === f.id ? (
            <input
              ref={renameRef}
              className="folder-rename"
              defaultValue={f.name}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename(f.id, (e.target as HTMLInputElement).value);
                else if (e.key === 'Escape') setRenamingFolder(null);
              }}
              onBlur={(e) => commitRename(f.id, e.target.value)}
            />
          ) : (
            <span className="folder-name">{f.name}</span>
          )}
          <span className="folder-count">{noteCount(f.id) || ''}</span>
          <button
            className={`disc${isOpen ? ' open' : ''}`}
            onClick={(e) => { e.stopPropagation(); toggleFolder(f.id); }}
            title={isOpen ? 'Collapse' : 'Expand'}
          >{Ico.chevron}</button>
        </div>
        {isOpen && (
          <div className="folder-children">
            {kids.map((c) => renderFolder(c, depth + 1))}
            {rows.map((n) => renderNoteRow(n, depth + 1))}
            {kids.length === 0 && rows.length === 0 && (
              <div className="folder-empty" style={{ paddingLeft: 9 + (depth + 1) * 15 }}>Empty</div>
            )}
          </div>
        )}
      </div>
    );
  };

  const rootFolders = childFolders(null);
  const rootNotes = notesInFolder(null);

  // Metadata for the header line under the title (only for a saved, selected note).
  const current = selectedId ? notes.find((n) => n.id === selectedId) : null;
  function relTime(iso: string) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const day = Math.round(h / 24);
    if (day === 1) return 'Yesterday';
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  const setSidebar = (open: boolean) => { setSidebarOpen(open); localStorage.setItem('nb-sidebar', open ? 'open' : 'closed'); };

  // Dark mode — stamp the theme on <html> so the [data-theme="dark"] token overrides apply.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('nb-theme', theme);
  }, [theme]);
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  // Drag the divider on the sidebar's right edge to resize it (clamped 200–520px, persisted).
  // The `resizing` body class force-disables text selection everywhere (incl. the editor)
  // so dragging over content never paints a selection.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    const onMove = (ev: MouseEvent) => {
      const w = Math.min(520, Math.max(200, ev.clientX));
      widthRef.current = w;
      setSidebarWidth(w);
    };
    const onUp = () => {
      document.body.classList.remove('resizing');
      localStorage.setItem('nb-sidebar-w', String(Math.round(widthRef.current)));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // Fallback: if the terminating mouseup is swallowed (Space/Mission-Control switch on macOS),
    // window blur still tears down the drag so the app isn't stranded with text-selection off.
    window.addEventListener('blur', onUp);
  };
  // Glossy, always-visible window controls (native traffic lights are hidden in main.ts).
  const winControls = (
    <div className="win-controls">
      <button className="tl tl-close" onClick={() => window.notebookAPI.closeWindow()} title="Close" />
      <button className="tl tl-min" onClick={() => window.notebookAPI.minimizeWindow()} title="Minimize" />
      <button className="tl tl-zoom" onClick={() => window.notebookAPI.zoomWindow()} title="Zoom" />
    </div>
  );

  return (
    <div className="app">
      {sidebarOpen && (
      <>
      <aside className="sidebar" style={{ width: sidebarWidth }}>
        <div className="sidebar-top">
          {winControls}
          <button className="icon-btn" onClick={() => setSidebar(false)} title="Hide sidebar">{Ico.sidebar}</button>
        </div>
        <div
          className={`note-list${dropTarget === '__root__' ? ' drop-target' : ''}`}
          onDragOver={allowDrop('__root__')}
          onDragLeave={() => setDropTarget((t) => (t === '__root__' ? null : t))}
          onDrop={onDropInto(null)}
          onContextMenu={(e) => { if (!(e.target as HTMLElement).closest('.note-row, .folder-row, button, input')) { e.preventDefault(); setMenuPos({ x: e.clientX, y: e.clientY }); setCreateOpen(true); } }}
          title="Two-finger click empty space to create a note or folder"
        >
          {notes.length === 0 && folders.length === 0 ? (
            <div className="empty-list">No notes yet.<br />Two-finger click here to make a note or folder, or capture text.</div>
          ) : (
            <>
              {rootFolders.map((f) => renderFolder(f, 0))}
              {rootNotes.map((n) => renderNoteRow(n, 0))}
            </>
          )}
        </div>
        <div className="sidebar-footer">
          <button className={`account-row${view === 'settings' ? ' active' : ''}`} onClick={() => setView('settings')} title="Settings & models">
            <span className="account-name">Settings &amp; models</span>
            <span className="account-gear">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
            </span>
          </button>
        </div>
      </aside>
      <div className="sidebar-resizer" onMouseDown={startResize} title="Drag to resize" />
      </>
      )}

      <main className="main">
        <div className="main-top">
          <div className="main-top-left">
            {!sidebarOpen && (
              <>
                {winControls}
                <button className="icon-btn" onClick={() => setSidebar(true)} title="Show sidebar">{Ico.sidebar}</button>
              </>
            )}
          </div>
          {view === 'notes' && streaming !== 'streaming' && (
            <div className="main-actions">
              <button onClick={() => setSearchOpen(true)} title="Search notes (⌘F)">{Ico.search}</button>
              <button onClick={() => newNote(null)} title="New note (⌘N)">{Ico.addNote}</button>
              <button onClick={toggleTheme} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>{theme === 'dark' ? Ico.sun : Ico.moon}</button>
            </div>
          )}
        </div>
        {view === 'settings' ? (
          <div className="settings-pane">
            <button className="settings-back" onClick={() => setView('notes')} title="Back to notes">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></svg>
              Back to notes
            </button>
            <div className="settings-combined">
              <ModelsView />
              <SettingsView hideModels />
            </div>
          </div>
        ) : (
        <>
        <input className="title-input" placeholder="Untitled" value={title} onChange={(e) => onTitleChange(e.target.value)} />
        {current && streaming !== 'streaming' && (current.model || current.sourceApp || current.createdAt) && (
          <div className="note-meta">
            {current.model && <span className="nm-model"><BrandIcon model={current.model} size={14} /> {current.model}</span>}
            {current.sourceApp && <><span className="nm-dot">·</span><span>{current.sourceApp}</span></>}
            {current.createdAt && relTime(current.createdAt) && <><span className="nm-dot">·</span><span>{relTime(current.createdAt)}</span></>}
            <span className="nm-dot">·</span><span>{words} {words === 1 ? 'word' : 'words'}</span>
          </div>
        )}
        {image && (
          <figure className="capture">
            <figcaption className="capture-cap">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /><circle cx="12" cy="13" r="3" /></svg>
              Capture
            </figcaption>
            <img src={image} alt="Screen capture" />
          </figure>
        )}
        <div className="editor-wrap" style={{ fontFamily: font, fontSize: `${size}px` }}>
          {streaming === 'streaming' ? (
            // Read-only pane while a notch answer streams in (becomes a saved note on done).
            <div ref={streamRef} className="editor streaming-pane" />
          ) : (
            // ponytail: userCommands intentionally not passed → slash menu shows built-ins only.
            // Custom commands are stored (settings-service.getCustomPresets / customPresets) but
            // have no IPC channel to reach this renderer and no settings UI to create them, so
            // nothing can populate them yet. Built-ins all resolve, so no misleading "couldn't
            // reach model" error is reachable. Wire userCommands once a custom-command settings UI
            // + a settings:get-custom-presets IPC exist.
            <NotebookEditor
              key={editorKey}
              noteId={selectedId}
              markdown={editorMarkdown}
              aiBlocks={editorBlocks}
              model={current?.model}
              onChange={onEditorChange}
              onEditorReady={setEditor}
            />
          )}
        </div>
        {streaming === 'error' && <div className="streaming-tag err">{streamErr}</div>}
        <div className="toolbar">
          <select value={font} onChange={(e) => applyFont(e.target.value)} title="Font">
            {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>
          <select value={size} onChange={(e) => applySize(e.target.value)} title="Size">
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {editor && (
            <>
              <span className="sep" />
              <button className={`ico${editor.isActive('codeBlock') ? ' active' : ''}`} onClick={toggleCode} title="Code block (syntax highlighted)">{Ico.code}</button>
              <select className="tb-lang" value={codeLang} onChange={(e) => applyCodeLang(e.target.value)} title="Code language">
                {CODE_LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
              <label className="color-btn" title="Text color">
                <span className="color-dot" style={{ background: textColor }} />
                <input type="color" value={textColor} onChange={(e) => applyColor(e.target.value)} />
              </label>
              <button className={`ico${editor.isActive('highlight') ? ' active' : ''}`} onClick={toggleHighlight} title="Highlight">{Ico.highlight}</button>
              <label className="color-btn" title="Highlight color">
                <span className="color-dot hl" style={{ background: hlColor }} />
                <input type="color" value={hlColor} onChange={(e) => applyHlColor(e.target.value)} />
              </label>
            </>
          )}
          {(words > 0 || selectedId) && (
            <>
              <span className="sep" />
              <button className="ico" onClick={copyNote} title="Copy as Markdown">{Ico.copy}</button>
              <button className="ico" onClick={exportNote} title="Export as Markdown (.md)">{Ico.download}</button>
            </>
          )}
        </div>
        </>
        )}
      </main>

      {actionTarget && (
        <div className="action-modal-backdrop" onMouseDown={closeActions}>
          <div className="action-modal" style={menuStyle(actionTarget.kind === 'note' ? 190 : 232)} onMouseDown={(e) => e.stopPropagation()}>
            {actionTarget.kind === 'note' ? (
              <>
                <div className="action-title">{actionTarget.note.title || 'Untitled'}</div>
                <button className="action-item" onClick={() => { const n = actionTarget.note; closeActions(); selectNote(n.id); }}>{Ico.note} Open note</button>
                <button className="action-item" onClick={() => { togglePin(actionTarget.note); closeActions(); }}>{Ico.pin} {actionTarget.note.pinned ? 'Unpin' : 'Pin'}</button>
                <button className="action-item danger" onClick={() => { const n = actionTarget.note; closeActions(); deleteNote(n); }}>{Ico.trash} Delete note</button>
              </>
            ) : (
              <>
                <div className="action-title">{actionTarget.folder.name}</div>
                <button className="action-item" onClick={() => { const id = actionTarget.folder.id; closeActions(); newNote(id); }}>{Ico.addNote} New note here</button>
                <button className="action-item" onClick={() => { const id = actionTarget.folder.id; closeActions(); newFolder(id); }}>{Ico.addFolder} New folder here</button>
                <button className="action-item" onClick={() => { const id = actionTarget.folder.id; closeActions(); setRenamingFolder(id); }}>{Ico.folder} Rename</button>
                <button className="action-item danger" onClick={() => { const f = actionTarget.folder; closeActions(); deleteFolder(f); }}>{Ico.trash} Delete folder</button>
              </>
            )}
          </div>
        </div>
      )}

      {createOpen && (
        <div className="action-modal-backdrop" onMouseDown={() => setCreateOpen(false)}>
          <div className="action-modal" style={menuStyle(120)} onMouseDown={(e) => e.stopPropagation()}>
            <div className="action-title">Create</div>
            <button className="action-item" onClick={() => { setCreateOpen(false); newNote(null); }}>{Ico.addNote} New note</button>
            <button className="action-item" onClick={() => { setCreateOpen(false); newFolder(null); }}>{Ico.addFolder} New folder</button>
          </div>
        </div>
      )}

      {searchOpen && (
        <div className="search-modal-backdrop" onMouseDown={closeSearch}>
          <div className="search-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="search-modal-input">
              <span className="search-icon">{Ico.search}</span>
              <input
                ref={searchRef}
                autoFocus
                placeholder="Search notes…"
                value={query}
                onChange={(e) => onSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') closeSearch(); }}
              />
              <kbd className="search-esc">esc</kbd>
            </div>
            <div className="search-modal-results">
              {query.trim() === '' ? (
                <div className="search-hint">Type to search across all your notes.</div>
              ) : results && results.length ? (
                results.map((n) => (
                  <button key={n.id} className="search-result" onClick={() => { selectNote(n.id); closeSearch(); }}>
                    <span className="row-icon">{n.model ? <BrandIcon model={n.model} size={16} /> : Ico.note}</span>
                    <span className="sr-body">
                      <span className="sr-title">{n.title || 'Untitled'}</span>
                      <span className="sr-snip">{n.snippet}</span>
                    </span>
                  </button>
                ))
              ) : (
                <div className="search-hint">No matches.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          <span className="toast-msg">{toast.msg}</span>
          {toast.undo && <button className="toast-undo" onClick={toast.undo}>Undo</button>}
        </div>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<Notebook />);
