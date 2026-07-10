import React, { useEffect, useRef, useState, useCallback, Suspense, lazy } from 'react';
import ReactDOM from 'react-dom/client';
import { BrandIcon } from './model-icon';
import { SettingsView } from './settings-view';
import { ModelsView } from './models-view';
import { NotebookEditor } from './editor/NotebookEditor';
import { ChatView } from './chat-view';
import type { Editor } from '@tiptap/react';
import './notebook.css';

// A drawing document renders a full Excalidraw canvas in the main area; lazy so Excalidraw
// (~2MB) lands in its own webpack chunk, fetched only when a drawing is first opened.
const DrawingDoc = lazy(() => import('./editor/drawing-doc'));

interface NotebookMeta { prompt: string; selection: string; sourceApp?: string; model: string }
interface NoteSummary { id: string; title: string; snippet: string; tags: string[]; sourceApp?: string; model?: string; sourceKind?: 'text' | 'image' | 'chat' | 'drawing'; imagePath?: string; pinned: boolean; createdAt: string }
interface AIBlockMeta { blockId: string; prompt: string; model: string; commandId?: string; selection?: string; createdAt: string }
interface DrawingMeta { drawingId: string; scene: unknown }
interface IncomingDrawing { drawingId: string; scene: unknown; png?: string }
interface NoteWithBlocks { body: string; aiBlocks: AIBlockMeta[]; drawings: DrawingMeta[] }
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
  getDrawImage: (drawingId: string) => Promise<string | null>;
  rename: (id: string, title: string) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setTags: (id: string, tags: string[]) => Promise<void>;
  getAllTags: () => Promise<string[]>;
  updateBody: (id: string, body: string, aiBlocks?: Array<Omit<AIBlockMeta, 'createdAt'>>, drawings?: IncomingDrawing[]) => Promise<void>;
  hide: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  createNote: (folderId?: string | null, kind?: 'note' | 'chat' | 'drawing') => Promise<string | null>;
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
  // Chat (source_kind=chat notes)
  chatGet: (noteId: string) => Promise<ChatTurn[]>;
  chatSend: (req: { noteId: string; text: string; model?: string; useRag?: boolean }) => Promise<{ ok: boolean; answer?: string; citations?: string[]; error?: string }>;
  chatAbort: (noteId: string) => Promise<void>;
  ragStatus: () => Promise<{ healthy: boolean; chunks: number; model: string }>;
  onChatToken: (cb: (p: { noteId: string; delta: string }) => void) => () => void;
  onChatDone: (cb: (p: { noteId: string; answer: string; citations: string[]; model: string }) => void) => () => void;
  onChatError: (cb: (p: { noteId: string; error: string }) => void) => () => void;
}
interface ChatTurn { role: 'user' | 'assistant'; content: string; model?: string; cites?: string[]; ts?: string }
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
  // Lucide file-text — the note glyph in list rows.
  note: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></svg>,
  // Lucide notebook-pen — the "new note" action.
  addNote: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4" /><path d="M2 6h4" /><path d="M2 10h4" /><path d="M2 14h4" /><path d="M2 18h4" /><path d="M21.378 5.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z" /></svg>,
  addFolder: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><line x1="12" y1="10" x2="12" y2="16" /><line x1="9" y1="13" x2="15" y2="13" /></svg>,
  // Lucide message-square — the chat glyph (row icon + new-chat button).
  chat: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>,
  sidebar: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" /></svg>,
  search: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
  code: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>,
  table: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" /></svg>,
  // Lucide pencil — the insert-drawing action.
  draw: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>,
  // Lucide palette — the drawing document/insert action (row icon + toolbar + new-drawing button).
  palette: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" /><circle cx="6.5" cy="12.5" r=".9" fill="currentColor" stroke="none" /><circle cx="8.5" cy="7.5" r=".9" fill="currentColor" stroke="none" /><circle cx="13.5" cy="6.5" r=".9" fill="currentColor" stroke="none" /><circle cx="17.5" cy="10.5" r=".9" fill="currentColor" stroke="none" /></svg>,
  highlight: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l-4 4v3h3l4-4" /><path d="M13 7l4 4" /><path d="M20.5 6.5a2.1 2.1 0 0 0-3-3L9 12l3 3z" /></svg>,
  spellcheck: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 8 8 12 16 4" /><path d="M3 18c1.5-2 3-2 4.5 0s3 2 4.5 0 3-2 4.5 0" /></svg>,
  // Lucide "heading" — the make-section-title button.
  heading: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 4v16" /><path d="M18 4v16" /><path d="M6 12h12" /></svg>,
  // Section outline toggle (table-of-contents).
  outline: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" /></svg>,
  moon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>,
  sun: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" /><line x1="4.2" y1="4.2" x2="5.6" y2="5.6" /><line x1="18.4" y1="18.4" x2="19.8" y2="19.8" /><line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" /><line x1="4.2" y1="19.8" x2="5.6" y2="18.4" /><line x1="18.4" y1="5.6" x2="19.8" y2="4.2" /></svg>,
};

const countWords = (text: string): number => {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
};

const EXPANDED_KEY = 'nb-expanded';
const loadExpanded = (): Set<string> => {
  try { const a = JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'); return new Set(Array.isArray(a) ? a : []); }
  catch { return new Set(); }
};

// Tag chips + inline add/remove for the open note. Tag text is untrusted (model/clipboard),
// so it only ever reaches the DOM through React children (textContent) — never innerHTML.
function TagEditor({ tags, allTags, onChange, onFilter }: {
  tags: string[];
  allTags: string[];
  onChange: (tags: string[]) => void;
  onFilter: (tag: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    setDraft('');
    if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    onChange([...tags, t]);
  };
  const remove = (tag: string) => onChange(tags.filter((x) => x !== tag));
  return (
    <div className="tag-editor">
      {tags.map((t) => (
        <span key={t} className="tag-chip">
          <button className="tag-chip-label" onClick={() => onFilter(t)} title={`Show notes tagged “${t}”`}>{t}</button>
          <button className="tag-chip-x" onClick={() => remove(t)} title="Remove tag" aria-label={`Remove tag ${t}`}>×</button>
        </span>
      ))}
      <input
        className="tag-add"
        list="nb-all-tags"
        placeholder={tags.length ? 'Add tag…' : 'Add a tag…'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(); }
          else if (e.key === 'Backspace' && !draft && tags.length) remove(tags[tags.length - 1]);
        }}
        onBlur={add}
      />
      <datalist id="nb-all-tags">{allTags.map((t) => <option key={t} value={t} />)}</datalist>
    </div>
  );
}

// Notification banner: top-right frosted panel with an always-visible close (top-left circle,
// brighter on hover) and swipe-right-to-dismiss — a mouse click-drag OR a trackpad two-finger
// horizontal swipe (wheel deltaX), like macOS.
function Toast({ msg, undo, onClose }: { msg: string; undo?: () => void; onClose: () => void }) {
  const [dx, setDxState] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const dxRef = useRef(0);
  const drag = useRef({ active: false, startX: 0 });
  const wheelEnd = useRef<ReturnType<typeof setTimeout> | null>(null);
  const DISMISS = 80; // px of rightward travel that commits a dismiss

  const setDx = (v: number) => { dxRef.current = v; setDxState(v); };
  const dismiss = () => { setLeaving(true); setDragging(false); setDx(540); setTimeout(onClose, 220); };
  const settle = () => { if (dxRef.current > DISMISS) dismiss(); else setDx(0); };

  // Mouse / pen drag — gated on a ref so no pointermove is missed to a stale state closure.
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // let the close/undo buttons click
    drag.current = { active: true, startX: e.clientX };
    setDragging(true);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onPointerMove = (e: React.PointerEvent) => { if (drag.current.active) setDx(Math.max(0, e.clientX - drag.current.startX)); };
  const onPointerUp = () => { if (!drag.current.active) return; drag.current.active = false; setDragging(false); settle(); };

  // Trackpad two-finger horizontal swipe arrives as wheel deltaX; snap back if it stops short.
  // A rightward swipe (to dismiss) is a NEGATIVE deltaX under natural scrolling, so subtract it.
  const onWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical scroll — ignore
    setDx(Math.max(0, Math.min(600, dxRef.current - e.deltaX)));
    if (dxRef.current > DISMISS) return dismiss();
    if (wheelEnd.current) clearTimeout(wheelEnd.current);
    wheelEnd.current = setTimeout(() => setDx(0), 150);
  };

  const moved = dragging || leaving || dx !== 0;
  return (
    <div
      className={`toast${leaving ? ' toast--leaving' : ''}`}
      role="status"
      style={moved ? { transform: `translateX(${dx}px)`, opacity: Math.max(0, 1 - dx / 260), transition: dragging ? 'none' : 'transform 0.22s ease, opacity 0.22s ease' } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    >
      <span className="toast-msg">{msg}</span>
      {undo && <button className="toast-undo" onClick={undo} type="button">Undo</button>}
    </div>
  );
}

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
  const [font] = useState(localStorage.getItem('nb-font') || 'Inter'); // wrapper base for unmarked text
  const [size] = useState(localStorage.getItem('nb-size') || '16');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NoteSummary[] | null>(null); // null = not searching
  const [tagFilter, setTagFilter] = useState<string | null>(null); // sidebar filtered to this tag
  const [allTags, setAllTags] = useState<string[]>([]); // distinct live tags (add-tag suggestions)
  const [searchOpen, setSearchOpen] = useState(false); // search modal
  const [actionTarget, setActionTarget] = useState<{ kind: 'note'; note: NoteSummary } | { kind: 'folder'; folder: Folder } | null>(null); // left-click actions modal
  const [createOpen, setCreateOpen] = useState(false); // "create note/folder" modal (empty-sidebar two-finger click)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 }); // where the last context menu opened
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('nb-theme') === 'dark' ? 'dark' : 'light'));
  const [view, setView] = useState<'notes' | 'settings'>('notes'); // right pane: editor / combined settings
  const [outlineOpen, setOutlineOpen] = useState(localStorage.getItem('nb-outline') !== 'off'); // section outline panel
  const [image, setImage] = useState<string | null>(null); // capture data URL for the selected note
  const [words, setWords] = useState(0); // live word count
  const [toast, setToast] = useState<{ msg: string; undo?: () => void } | null>(null);

  // Markdown + AI-block metadata that seed the TipTap editor for the selected/new note.
  // editorKey forces a remount (and re-seed) whenever the note changes — useEditor only reads
  // `content` once.
  const [editorMarkdown, setEditorMarkdown] = useState('');
  const [editorBlocks, setEditorBlocks] = useState<AIBlockMeta[]>([]);
  const [editorDrawings, setEditorDrawings] = useState<DrawingMeta[]>([]);
  const [editorKey, setEditorKey] = useState(0);
  const [editor, setEditor] = useState<Editor | null>(null); // live TipTap instance (for color/code toolbar)
  const [textColor, setTextColor] = useState('#26251e');
  const [hlColor, setHlColor] = useState('#ffe37a');
  const [spellcheck, setSpellcheck] = useState(() => localStorage.getItem('nb-spellcheck') !== 'off');
  // Table grid picker (Google-Docs style): hover an N×M region, click to insert.
  const [tableMenuOpen, setTableMenuOpen] = useState(false);
  const [tableHover, setTableHover] = useState({ r: 0, c: 0 });
  const tableBtnRef = useRef<HTMLDivElement>(null);
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
  const refreshTags = useCallback(async () => {
    try { setAllTags(await window.notebookAPI.getAllTags()); } catch { /* ignore */ }
  }, []);

  // Persist a note's tags (frontmatter is source of truth → main writes the .md + reindexes),
  // then refresh the list (chips) and the distinct-tag suggestions.
  const saveTags = useCallback(async (id: string, tags: string[]) => {
    await window.notebookAPI.setTags(id, tags).catch(() => {});
    await refresh();
    refreshTags();
  }, [refresh, refreshTags]);

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
  const loadEditor = useCallback((markdown: string, blocks: AIBlockMeta[] = [], draws: DrawingMeta[] = []) => {
    liveMarkdown.current = markdown;
    setEditorMarkdown(markdown);
    setEditorBlocks(blocks);
    setEditorDrawings(draws);
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
    loadEditor(note?.body ?? '', note?.aiBlocks ?? [], note?.drawings ?? []);
    setImage(img);
  }, [notes, loadEditor, flushRename]);

  useEffect(() => {
    (async () => {
      const [list] = await Promise.all([window.notebookAPI.list(), refreshFolders(), refreshTags()]);
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
      refreshTags(); // a captured note may carry auto tags (sourceApp/language)
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
    left: Math.max(8, Math.min(menuPos.x, window.innerWidth - 240)),
    top: Math.max(8, Math.min(menuPos.y, window.innerHeight - h - 8)),
  });

  function togglePin(n: NoteSummary) {
    window.notebookAPI.setPinned(n.id, !n.pinned).then(refresh).catch(() => {});
  }

  // Filter the sidebar to a tag (open the sidebar so the result is visible).
  function applyTagFilter(tag: string) {
    setTagFilter(tag);
    setSidebarOpen(true);
    localStorage.setItem('nb-sidebar', 'open');
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

  // Close the table grid picker on an outside click.
  useEffect(() => {
    if (!tableMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (tableBtnRef.current && !tableBtnRef.current.contains(e.target as Node)) setTableMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [tableMenuOpen]);

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
  const onEditorChange = useCallback((id: string | null, markdown: string, aiBlocks: Array<Omit<AIBlockMeta, 'createdAt'>>, drawings: IncomingDrawing[]) => {
    if (id === selectedRef.current) {
      liveMarkdown.current = markdown;
      setWords(countWords(markdown));
    }
    if (id) {
      window.notebookAPI.updateBody(id, markdown, aiBlocks, drawings).then(refresh).catch(() => {});
    }
  }, [refresh]);

  // Docs-style: always write a textStyle mark. With a selection it formats that text; with an
  // empty cursor setFontFamily/setFontSize leave a stored mark so the next typed text picks it up.
  // The mark lives in the doc → undo/redo captures it. (`font`/`size` remain the wrapper base for
  // any text that carries no mark.)
  function applyFont(f: string) { editor?.chain().focus().setFontFamily(f).run(); }
  function applySize(s: string) { editor?.chain().focus().setFontSize(`${s}px`).run(); }
  // Re-render the toolbar on every transaction (incl. pure cursor moves) so the font/size pickers
  // reflect the mark under the caret. Without this the component only re-renders on content change.
  const [, bumpToolbar] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const tick = () => bumpToolbar((n) => n + 1);
    editor.on('transaction', tick);
    return () => { editor.off('transaction', tick); };
  }, [editor]);
  // What the toolbar controls display: the mark under the current selection/caret, falling back
  // to the last-picked value / base. `<input type=color>` needs a #rrggbb — on-disk markdown can
  // carry rgb()/named colors, so only surface a value we can prove is a plain 6-digit hex.
  const asHex = (v: unknown): string | undefined => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
  const curFont = (editor && editor.getAttributes('textStyle').fontFamily) || font;
  const curSize = (editor && (editor.getAttributes('textStyle').fontSize as string | undefined)?.replace('px', '')) || size;
  const curColor = (editor && asHex(editor.getAttributes('textStyle').color)) || textColor;
  const curHl = (editor && asHex(editor.getAttributes('highlight').color)) || hlColor;
  // Make the selected block a section title (H2). Toggles back to a paragraph if already one.
  function toggleSection() { editor?.chain().focus().toggleHeading({ level: 2 }).run(); }
  // Live section outline: every heading in the doc → click an item to jump to it. Cheap doc walk,
  // recomputed each render (the toolbar already re-renders on every transaction, above).
  const outline: { pos: number; level: number; text: string }[] = [];
  if (editor) editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') outline.push({ pos, level: node.attrs.level as number, text: node.textContent.trim() || 'Untitled section' });
  });
  function jumpToHeading(pos: number) { editor?.chain().focus().setTextSelection(pos + 1).scrollIntoView().run(); }
  function toggleOutline() { setOutlineOpen((v) => { localStorage.setItem('nb-outline', v ? 'off' : 'on'); return !v; }); }
  function applyColor(hex: string) { setTextColor(hex); editor?.chain().focus().setColor(hex).run(); }
  // Toggle the red squiggle. spellcheck lives on the contenteditable DOM node, so drive it
  // directly on the editor's view; reapply whenever the editor remounts (note switch).
  useEffect(() => {
    editor?.view.dom.setAttribute('spellcheck', spellcheck ? 'true' : 'false');
  }, [editor, spellcheck]);
  function toggleSpellcheck() {
    setSpellcheck((v) => { localStorage.setItem('nb-spellcheck', v ? 'off' : 'on'); return !v; });
  }
  function toggleHighlight() { editor?.chain().focus().toggleHighlight({ color: hlColor }).run(); }
  function applyHlColor(hex: string) { setHlColor(hex); editor?.chain().focus().setHighlight({ color: hex }).run(); }
  // Language is picked on the block itself (in-block dropdown, see code-block-view); the
  // toolbar button just toggles the block into/out of code.
  function toggleCode() {
    if (!editor) return;
    // Already in a code block → convert it back to a paragraph.
    if (editor.isActive('codeBlock')) { editor.chain().focus().toggleCodeBlock().run(); return; }
    // Otherwise insert a NEW code block holding only the selected text (empty if nothing's
    // selected) — never absorb the rest of the current line the way toggleCodeBlock() would.
    const { from, to, empty } = editor.state.selection;
    const text = empty ? '' : editor.state.doc.textBetween(from, to, '\n');
    editor.chain().focus().insertContent({
      type: 'codeBlock',
      content: text ? [{ type: 'text', text }] : [],
    }).run();
  }
  function insertTable(rows: number, cols: number) {
    editor?.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();
    setTableMenuOpen(false);
  }
  // Insert an empty drawing node and immediately open the Excalidraw canvas on it (the modal
  // is owned by NotebookEditor and reached via the shared editor's `drawing.onEdit` storage).
  function insertDrawing() {
    if (!editor) return;
    const drawingId = crypto.randomUUID();
    editor.chain().focus().insertContent({ type: 'drawing', attrs: { drawingId, scene: null, png: null } }).run();
    (editor.storage as { drawing?: { onEdit?: (id: string) => void } }).drawing?.onEdit?.(drawingId);
  }

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
        return { id: h.id, title: n?.title ?? h.snippet, snippet: h.snippet, tags: n?.tags ?? h.tags ?? [], sourceApp: n?.sourceApp, model: n?.model, pinned: n?.pinned ?? false, createdAt: n?.createdAt ?? '' };
      }));
    }, 180);
  }

  // --- creation --------------------------------------------------------------------------
  // New note (optionally inside a folder). Persists immediately so the note can live in the
  // tree, then loads it into the editor.
  async function newNote(folderId: string | null = null, kind: 'note' | 'chat' | 'drawing' = 'note') {
    streamingRef.current = false; setStreaming('idle');
    setView('notes');
    const id = await window.notebookAPI.createNote(folderId, kind).catch(() => null);
    await refreshFolders();
    const list = await window.notebookAPI.list();
    setNotes(list);
    if (folderId) expandFolder(folderId);
    if (id) selectNote(id, list);
    else { setSelectedId(null); selectedRef.current = null; setTitle(''); loadEditor(''); }
  }
  const newChat = (folderId: string | null = null) => newNote(folderId, 'chat');
  const newDrawing = (folderId: string | null = null) => newNote(folderId, 'drawing');

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
      <span className="row-icon">{n.pinned ? Ico.pin : n.sourceKind === 'chat' ? Ico.chat : n.sourceKind === 'drawing' ? Ico.palette : n.model ? <BrandIcon model={n.model} size={16} /> : Ico.note}</span>
      <div className="body">
        <div className="title">{n.title || 'Untitled'}</div>
        <div className="meta">{n.createdAt && relTime(n.createdAt) ? `${relTime(n.createdAt)} · ` : ''}{n.snippet}</div>
        {n.tags.length > 0 && (
          <div className="row-tags">
            {n.tags.slice(0, 3).map((t) => (
              <button
                key={t}
                className={`row-tag${tagFilter && t.toLowerCase() === tagFilter.toLowerCase() ? ' active' : ''}`}
                onClick={(e) => { e.stopPropagation(); applyTagFilter(t); }}
                title={`Show notes tagged “${t}”`}
              >{t}</button>
            ))}
            {n.tags.length > 3 && <span className="row-tag-more">+{n.tags.length - 3}</span>}
          </div>
        )}
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
          // --depth drives the CSS guide line (::before) that connects nested notes/folders.
          <div className="folder-children" style={{ ['--depth' as string]: depth } as React.CSSProperties}>
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
  // When a tag filter is active the folder tree is bypassed for a flat list of matching notes.
  const filteredNotes = tagFilter
    ? notes.filter((n) => n.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase()))
    : null;

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
          {tagFilter ? (
            <>
              <div className="tag-filter-bar">
                <span className="tfb-label">Tagged <span className="tag-chip static">{tagFilter}</span></span>
                <button className="tfb-clear" onClick={() => setTagFilter(null)} title="Show all notes">All notes</button>
              </div>
              {filteredNotes && filteredNotes.length ? (
                filteredNotes.map((n) => renderNoteRow(n, 0))
              ) : (
                <div className="folder-empty" style={{ paddingLeft: 9 }}>No notes with this tag.</div>
              )}
            </>
          ) : notes.length === 0 && folders.length === 0 ? (
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
              <button className={outlineOpen ? 'active' : ''} onClick={toggleOutline} title={outlineOpen ? 'Hide sections' : 'Show sections'}>{Ico.outline}</button>
              <button onClick={() => setSearchOpen(true)} title="Search notes (⌘F)">{Ico.search}</button>
              <button onClick={() => newDrawing(null)} title="New drawing">{Ico.palette}</button>
              <button onClick={() => newNote(null)} title="New note (⌘N)">{Ico.addNote}</button>
              <button onClick={() => newChat(null)} title="New chat">{Ico.chat}</button>
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
        ) : current?.sourceKind === 'chat' ? (
          <>
            <input className="title-input" placeholder="New chat" value={title} onChange={(e) => onTitleChange(e.target.value)} />
            <ChatView
              noteId={current.id}
              notes={notes.map((n) => ({ id: n.id, title: n.title }))}
              onOpenNote={(id) => selectNote(id)}
              onTurnsChanged={() => window.notebookAPI.list().then(setNotes)}
            />
          </>
        ) : current?.sourceKind === 'drawing' ? (
          <>
            <input className="title-input" placeholder="Untitled drawing" value={title} onChange={(e) => onTitleChange(e.target.value)} />
            <Suspense fallback={<div className="draw-doc draw-doc--loading">Loading canvas…</div>}>
              <DrawingDoc key={current.id} noteId={current.id} onSaved={refresh} />
            </Suspense>
          </>
        ) : (
        <div className="note-layout">
        <div className="note-col">
        <input className="title-input" placeholder="Untitled" value={title} onChange={(e) => onTitleChange(e.target.value)} />
        {current && streaming !== 'streaming' && (current.model || current.sourceApp || current.createdAt) && (
          <div className="note-meta">
            {current.model && <span className="nm-model"><BrandIcon model={current.model} size={14} /> {current.model}</span>}
            {current.sourceApp && <><span className="nm-dot">·</span><span>{current.sourceApp}</span></>}
            {current.createdAt && relTime(current.createdAt) && <><span className="nm-dot">·</span><span>{relTime(current.createdAt)}</span></>}
            <span className="nm-dot">·</span><span>{words} {words === 1 ? 'word' : 'words'}</span>
          </div>
        )}
        {current && streaming !== 'streaming' && (
          <div className="tag-row">
            <TagEditor
              tags={current.tags}
              allTags={allTags}
              onChange={(t) => saveTags(current.id, t)}
              onFilter={applyTagFilter}
            />
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
              drawings={editorDrawings}
              model={current?.model}
              onChange={onEditorChange}
              onEditorReady={setEditor}
            />
          )}
        </div>
        {streaming === 'error' && <div className="streaming-tag err">{streamErr}</div>}
        <div className="toolbar">
          <select value={curFont} onChange={(e) => applyFont(e.target.value)} title="Font">
            {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
          </select>
          <select value={curSize} onChange={(e) => applySize(e.target.value)} title="Size">
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          {editor && (
            <>
              <span className="sep" />
              <button className={`ico${editor.isActive('heading', { level: 2 }) ? ' active' : ''}`} onClick={toggleSection} title="Make section title">{Ico.heading}</button>
              <button className={`ico${editor.isActive('codeBlock') ? ' active' : ''}`} onClick={toggleCode} title="Code block (pick language on the block)">{Ico.code}</button>
              <button className="ico" onClick={insertDrawing} title="Insert drawing">{Ico.palette}</button>
              <div className="tb-table" ref={tableBtnRef}>
                <button className={`ico${editor.isActive('table') ? ' active' : ''}`} onClick={() => setTableMenuOpen((v) => !v)} title="Insert table">{Ico.table}</button>
                {tableMenuOpen && (
                  <div className="grid-pop" onMouseLeave={() => setTableHover({ r: 0, c: 0 })}>
                    <div className="grid">
                      {Array.from({ length: 6 }).map((_, r) =>
                        Array.from({ length: 8 }).map((_, c) => (
                          <span
                            key={`${r}-${c}`}
                            className={`gcell${r <= tableHover.r && c <= tableHover.c ? ' on' : ''}`}
                            onMouseEnter={() => setTableHover({ r, c })}
                            onMouseDown={(e) => { e.preventDefault(); insertTable(r + 1, c + 1); }}
                          />
                        ))
                      )}
                    </div>
                    <div className="grid-label">{tableHover.c + 1} × {tableHover.r + 1}</div>
                  </div>
                )}
              </div>
              <label className="color-btn" title="Text color">
                <span className="color-dot" style={{ background: curColor }} />
                <input type="color" value={curColor} onChange={(e) => applyColor(e.target.value)} />
              </label>
              <button className={`ico${editor.isActive('highlight') ? ' active' : ''}`} onClick={toggleHighlight} title="Highlight">{Ico.highlight}</button>
              <label className="color-btn" title="Highlight color">
                <span className="color-dot hl" style={{ background: curHl }} />
                <input type="color" value={curHl} onChange={(e) => applyHlColor(e.target.value)} />
              </label>
              <span className="sep" />
              <button className={`ico${spellcheck ? ' active' : ''}`} onClick={toggleSpellcheck} title={spellcheck ? 'Spell check on' : 'Spell check off'}>{Ico.spellcheck}</button>
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
        </div>
        {outlineOpen && outline.length > 0 && (
          <aside className="outline">
            <div className="outline-head">Sections</div>
            <div className="outline-list">
              {outline.map((h, i) => (
                <button key={i} className={`outline-item lvl${h.level}`} onClick={() => jumpToHeading(h.pos)} title={h.text}>{h.text}</button>
              ))}
            </div>
          </aside>
        )}
        </div>
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
                <button className="action-item" onClick={() => { const id = actionTarget.folder.id; closeActions(); newChat(id); }}>{Ico.chat} New chat here</button>
                <button className="action-item" onClick={() => { const id = actionTarget.folder.id; closeActions(); newDrawing(id); }}>{Ico.palette} New drawing here</button>
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
            <button className="action-item" onClick={() => { setCreateOpen(false); newChat(null); }}>{Ico.chat} New chat</button>
            <button className="action-item" onClick={() => { setCreateOpen(false); newDrawing(null); }}>{Ico.palette} New drawing</button>
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
                    <span className="row-icon">{n.sourceKind === 'chat' ? Ico.chat : n.sourceKind === 'drawing' ? Ico.palette : n.model ? <BrandIcon model={n.model} size={16} /> : Ico.note}</span>
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
        <Toast key={toast.msg} msg={toast.msg} undo={toast.undo} onClose={() => setToast(null)} />
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<Notebook />);
