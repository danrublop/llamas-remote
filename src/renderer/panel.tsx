import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactDOM from 'react-dom/client';
import { BrandIcon } from './model-icon';
// Deep per-icon imports (the lucide-react barrel pulls in all ~1000 icons / ~700KB).
import NotebookText from 'lucide-react/dist/esm/icons/notebook-text';
import Crop from 'lucide-react/dist/esm/icons/crop';
import ScanText from 'lucide-react/dist/esm/icons/scan-text';
import Bug from 'lucide-react/dist/esm/icons/bug';
import Languages from 'lucide-react/dist/esm/icons/languages';
import PenLine from 'lucide-react/dist/esm/icons/pen-line';
import AlignLeft from 'lucide-react/dist/esm/icons/align-left';
import Paperclip from 'lucide-react/dist/esm/icons/paperclip';
import CornerDownLeft from 'lucide-react/dist/esm/icons/corner-down-left';
import ArrowUpRight from 'lucide-react/dist/esm/icons/arrow-up-right';
import Check from 'lucide-react/dist/esm/icons/check';
import Copy from 'lucide-react/dist/esm/icons/copy';
import X from 'lucide-react/dist/esm/icons/x';
import { decideEscapeAction, decideBlurAction, reconcilePick, draftAfter, statusAfterDismiss } from './panel-dismiss';
import './panel.css';

interface PanelQueryRequest {
  kind: 'text' | 'image';
  presetId?: string;
  freeText?: string;
  selection?: string;
  sourceApp?: string;
  imagePath?: string;
  userSelectedModel?: string;
  attachments?: string[];
}
interface PanelQueryResult { ok: boolean; answer?: string; model?: string; entryId?: string; error?: string }
interface PanelCaptured { selection: string; sourceApp?: string; empty: boolean; error?: string }
interface LlamasAPI {
  runQuery: (req: PanelQueryRequest) => Promise<PanelQueryResult>;
  captureScreenshot: () => Promise<string | null>;
  ocrCapture: () => Promise<{ text: string; cancelled?: boolean; error?: string }>;
  listModels: () => Promise<string[]>;
  getDefaults: () => Promise<{ text?: string; vision?: string }>;
  setDefaultModel: (kind: 'text' | 'vision', model: string) => Promise<void>;
  copyText: (text: string) => void;
  openNotebook: () => void;
  openSettings: () => void;
  pickFiles: () => Promise<Array<{ path: string; name: string }>>;
  requestCapture: () => Promise<{ selection: string; sourceApp?: string; empty: boolean; error?: string }>;
  close: () => void;
  setInteractive: (on: boolean) => void;
  focus: () => void;
  onCaptured: (cb: (data: PanelCaptured) => void) => () => void;
  onExpand: (cb: () => void) => () => void;
  onCollapse: (cb: () => void) => () => void;
}
declare global { interface Window { llamasAPI: LlamasAPI } }

// Preset action shortcuts (preset id -> label + Lucide icon). "Ask" is separate.
const ACTIONS = [
  { id: 'find-bugs', name: 'Debug', Icon: Bug },
  { id: 'translate', name: 'Translate', Icon: Languages },
  { id: 'rewrite', name: 'Rephrase', Icon: PenLine },
  { id: 'summarize', name: 'Summarize', Icon: AlignLeft },
];

type Status = 'idle' | 'running' | 'done' | 'error';

// Circular "context" meter: a ring that fills with the queued selection's size and shows
// the percent inside (like a cursor download/progress ring).
function CircleMeter({ pct, size = 22 }: { pct: number; size?: number }) {
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  const center = size / 2;
  return (
    <span className="meter" title={`${pct}% of context budget queued`}>
      <svg width={size} height={size}>
        <circle cx={center} cy={center} r={r} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={stroke} />
        <circle
          cx={center} cy={center} r={r} fill="none" stroke="#ffffff" strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <span className="meter-pct">{pct}</span>
    </span>
  );
}

function Panel() {
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState('');
  const [sourceApp, setSourceApp] = useState<string | undefined>();
  const [freeText, setFreeText] = useState('');
  const [attachments, setAttachments] = useState<Array<{ path: string; name: string }>>([]);
  const [models, setModels] = useState<string[]>([]);
  // `model` is the user's EXPLICIT panel pick (empty = "use the saved default"). When empty
  // we don't send userSelectedModel, so routing falls to the Models-page default.
  const [model, setModel] = useState(localStorage.getItem('lr-model') || '');
  const [defaultModel, setDefaultModelState] = useState('');
  const [modelOpen, setModelOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const typeInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const islandRef = useRef<HTMLDivElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);

  const refreshModels = useCallback(() => {
    window.llamasAPI.listModels().then((m) => {
      setModels(m);
      // Drop a stale explicit pick (model since uninstalled); do NOT auto-select the first
      // model, so an empty pick lets the saved default drive routing. `models` state
      // persists across collapse/expand (the panel never unmounts), so this background
      // refresh updates the already-rendered list without a flash.
      setModel((cur) => reconcilePick(cur, m));
    }).catch(() => {});
    // Pull the saved default so the picker can show it when there's no explicit pick.
    window.llamasAPI.getDefaults().then((d) => setDefaultModelState(d.text || '')).catch(() => {});
  }, []);

  const expandedRef = useRef(false);
  const pinnedRef = useRef(false);
  const interactiveRef = useRef(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `selection` for the async capture callbacks (so we can tell whether a freshly
  // captured selection actually changed, to clear a stale draft). Same pattern as expandedRef.
  const selectionRef = useRef('');
  // True while a native picker/screenshot/OCR is open — those blur the window legitimately
  // and must NOT trigger the window-blur dismiss.
  const captureInFlightRef = useRef(false);
  expandedRef.current = expanded;
  selectionRef.current = selection;

  const setInteractive = useCallback((on: boolean) => {
    if (interactiveRef.current === on) return;
    interactiveRef.current = on;
    window.llamasAPI.setInteractive(on);
  }, []);

  // Pin the panel open (don't auto-collapse on mouse-leave) AND grab keyboard focus, so a
  // hover-opened panel — which is interactive but not key — can be dismissed by Esc/blur.
  const pin = useCallback(() => {
    pinnedRef.current = true;
    window.llamasAPI.focus();
  }, []);

  const open = useCallback((doCapture = true) => {
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; }
    const wasCollapsed = !expandedRef.current;
    expandedRef.current = true; // set synchronously so rapid mousemoves don't re-open/re-capture
    setExpanded(true);
    setInteractive(true);
    // Grab the selection as we open (source app is still frontmost — the panel becomes
    // mouse-interactive without taking key focus). Skip when main already captured (hotkey).
    if (wasCollapsed) {
      refreshModels(); // pick up models pulled / keys added in Settings since last open
      if (doCapture) {
        window.llamasAPI.requestCapture().then((r) => {
          // A different selection means a preserved draft was about the OLD selection —
          // clear it so it can't leak onto this one. Same selection keeps the draft.
          const changed = selectionRef.current !== r.selection;
          setSelection(r.selection);
          setSourceApp(r.sourceApp);
          setFreeText((d) => draftAfter({ kind: 'capture', changed }, d));
          if (changed) setAttachments([]);
          if (r.error) { setError(r.error); setStatus('error'); }
        }).catch(() => {});
      }
    }
  }, [setInteractive, refreshModels]);

  const collapseNow = useCallback(() => {
    setExpanded(false);
    setInteractive(false);
    pinnedRef.current = false;
    // Preserve the user's draft (freeText/attachments) across a melt-to-nub so an accidental
    // dismiss doesn't lose a half-typed question; it's cleared on fire-success / new capture.
    // Preserve `running` so reopening mid-stream still shows the working indicator (the
    // answer keeps streaming into the notebook regardless of the panel).
    setStatus((s) => statusAfterDismiss(s));
    setAnswer('');
    setTyping(false);
    setModelOpen(false);
  }, [setInteractive]);

  const scheduleCollapse = useCallback(() => {
    if (pinnedRef.current) return;
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(collapseNow, 240);
  }, [collapseNow]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (expandedRef.current) return;
      const r = islandRef.current?.getBoundingClientRect();
      const pad = 4;
      const over = !!r && e.clientX >= r.left - pad && e.clientX <= r.right + pad && e.clientY <= r.bottom + pad;
      if (over) open();
    }
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [open]);

  // Close the model dropdown on an outside click.
  useEffect(() => {
    if (!modelOpen) return;
    function onDown(e: MouseEvent) {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) setModelOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modelOpen]);

  useEffect(() => {
    refreshModels();
    const offCap = window.llamasAPI.onCaptured((data) => {
      const changed = selectionRef.current !== data.selection;
      setSelection(data.selection);
      setSourceApp(data.sourceApp);
      setFreeText((d) => draftAfter({ kind: 'capture', changed }, d));
      if (changed) setAttachments([]);
      if (data.error) { setError(data.error); setStatus('error'); }
      else { setStatus('idle'); setError(''); }
    });
    const offExpand = window.llamasAPI.onExpand(() => { pin(); open(false); });
    const offCollapse = window.llamasAPI.onCollapse(() => collapseNow());
    return () => { offCap(); offExpand(); offCollapse(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, collapseNow, pin]);

  // Reliable dismiss for the FOCUSED panel: Esc (two-stage) and renderer window-blur, both
  // funneling into collapseNow (bypassing pinnedRef — these are explicit dismisses). The
  // listener re-installs on [typing, expanded] so it always reads current state (one source
  // of truth, no mirror refs). The capture guard keeps a native picker from self-dismissing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const action = decideEscapeAction({ typing, expanded });
      if (action === 'close-input') setTyping(false);
      else if (action === 'collapse') collapseNow();
    };
    const onWindowBlur = () => {
      if (decideBlurAction({ captureInFlight: captureInFlightRef.current }) === 'collapse') collapseNow();
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onWindowBlur);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('blur', onWindowBlur); };
  }, [typing, expanded, collapseNow]);

  async function fire(req: PanelQueryRequest) {
    pin();
    setError('');
    setAnswer('');
    setStatus('running');
    const res = await window.llamasAPI.runQuery({
      ...req,
      userSelectedModel: model || undefined,
      attachments: attachments.length ? attachments.map((a) => a.path) : undefined,
    });
    if (res.ok) {
      setAnswer(res.answer ?? '');
      setStatus('done');
      // The draft did its job — clear it so the next open starts fresh.
      setFreeText((d) => draftAfter({ kind: 'fire-success' }, d));
      setAttachments([]);
    } else { setError(res.error ?? 'Something went wrong'); setStatus('error'); }
  }

  async function attachFiles() {
    pin();
    captureInFlightRef.current = true;
    try {
      const picked = await window.llamasAPI.pickFiles();
      if (!picked.length) return;
      // De-dupe by path so re-picking the same file doesn't stack chips.
      setAttachments((prev) => {
        const seen = new Set(prev.map((a) => a.path));
        return [...prev, ...picked.filter((p) => !seen.has(p.path))];
      });
    } finally { captureInFlightRef.current = false; }
  }

  function runAction(presetId: string) {
    if (!selection.trim() && !freeText.trim() && attachments.length === 0) {
      setError('Select text, attach a file, or type a question'); setStatus('error');
      return;
    }
    fire({ kind: 'text', presetId, selection, sourceApp, freeText: freeText.trim() || undefined });
  }

  async function screenshot() {
    pin();
    captureInFlightRef.current = true;
    let path: string | null = null;
    try { path = await window.llamasAPI.captureScreenshot(); }
    finally { captureInFlightRef.current = false; }
    if (path) fire({ kind: 'image', presetId: 'explain', imagePath: path });
  }

  // Grab text from a screen region via on-device OCR (no model). The recognized text
  // becomes the queued selection, so you can then run a preset / ask a text model on it —
  // or just open it in the notebook. No vision model, no RAM cost.
  async function grabText() {
    pin();
    captureInFlightRef.current = true;
    let res: { text: string; cancelled?: boolean; error?: string };
    try { res = await window.llamasAPI.ocrCapture(); }
    finally { captureInFlightRef.current = false; }
    if (res.cancelled) return;
    if (res.error) { setError(res.error); setStatus('error'); return; }
    const text = res.text.trim();
    if (text) { setSelection(res.text); setSourceApp('Screen text'); setError(''); setStatus('idle'); }
    else { setError('No text found in that region.'); setStatus('error'); }
  }

  function cancelCollapse() {
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; }
  }

  // What to SHOW in the picker: the explicit pick, else the saved default. Routing uses
  // `model || undefined` (so an empty pick defers to the default), but the UI shows the
  // model that will actually answer.
  const effectiveModel = model || defaultModel;
  const hasSelection = selection.trim().length > 0;
  const selChars = selection.trim().length;
  // % of a rough context budget (~8000 chars) the selection fills; min 1% when non-empty.
  const ctxPct = hasSelection ? Math.max(1, Math.min(100, Math.round((selChars / 8000) * 100))) : 0;
  const busy = status === 'running';
  // Copy the queued selection to the clipboard (notch-as-clipboard) with a brief check.
  const copySelection = useCallback(() => {
    window.llamasAPI.copyText(selection);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1200);
  }, [selection]);
  // The arrow-top-right button opens the notebook. Icon-only while working; labelled "Open" once done.
  const openBtn = (label: boolean) => (
    <button className={`box-open${label ? '' : ' icon-only'}`} title="Open in notebook" onClick={() => window.llamasAPI.openNotebook()}>
      {label && <span>Open</span>}<ArrowUpRight size={label ? 14 : 16} />
    </button>
  );

  return (
    <div className="stage">
      <div
        ref={islandRef}
        className={`island${expanded ? ' expanded' : ''}${modelOpen ? ' menu-open' : ''}`}
        onMouseEnter={() => { cancelCollapse(); if (!expandedRef.current) open(); }}
        onMouseLeave={scheduleCollapse}
      >
        {/* Collapsed: current model logo (left); right shows a context counter of the
            queued selection (chars), else the idle waveform (notch sits between). */}
        <div className="collapsed">
          <span className="c-left">{effectiveModel ? <BrandIcon model={effectiveModel} size={16} /> : <span className="dot" />}</span>
          <span className="c-right">
            <CircleMeter pct={ctxPct} />
          </span>
        </div>

        {/* Expanded: compact launcher */}
        <div className="panel">
          <div className="hdr">
            <div className="model-picker" ref={modelPickerRef}>
              <button className="model-btn" onClick={() => setModelOpen((v) => !v)} title="Choose model">
                {effectiveModel ? <BrandIcon model={effectiveModel} size={17} /> : <span className="dot" />}
                <span className="model-chip">{effectiveModel || 'default model'}</span>
              </button>
              {modelOpen && (
                <div className="model-menu">
                  {models.length === 0 && <div className="model-opt muted">no models installed</div>}
                  {models.map((m) => (
                    <button
                      key={m}
                      className={`model-opt${m === effectiveModel ? ' on' : ''}`}
                      // Picking in the panel also saves it as the default, so the Models page
                      // and the panel agree on which model answers.
                      onClick={() => {
                        setModel(m); localStorage.setItem('lr-model', m);
                        setDefaultModelState(m); window.llamasAPI.setDefaultModel('text', m);
                        setModelOpen(false);
                      }}
                    >
                      <BrandIcon model={m} size={15} />
                      <span className="model-name">{m}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="spacer" />
            <button className="ghost-btn icon-only" onClick={() => window.llamasAPI.openNotebook()} title="Open notebook"><NotebookText size={16} /></button>
            {/* Focus-independent dismiss: always works even on a hover-opened (unfocused),
                pinned panel where Esc/blur can't fire. This is the fix for "no way to close". */}
            <button className="ghost-btn icon-only" onClick={() => collapseNow()} title="Close (Esc)"><X size={16} /></button>
            <CircleMeter pct={ctxPct} />
          </div>

          {/* Action buttons — icon-only circles. ? opens an ask input; presets fire on tap. */}
          <div className="actions-row">
            <div className="preset-actions">
              <button
                className={`cbtn ask${typing ? ' on' : ''}`}
                disabled={busy}
                title="Ask a question"
                onClick={() => { setTyping((v) => !v); pin(); setTimeout(() => typeInputRef.current?.focus(), 60); }}
              ><span className="qm">?</span></button>
              {ACTIONS.map((a) => (
                <button key={a.id} className="cbtn" disabled={busy} title={a.name} onClick={() => runAction(a.id)}>
                  <a.Icon size={16} />
                </button>
              ))}
            </div>
            <span className="spacer" />
            <button className="cbtn" onClick={attachFiles} disabled={busy} title="Attach files"><Paperclip size={16} /></button>
            <button className="cbtn" onClick={grabText} disabled={busy} title="Grab text from a screen region (OCR — no model)"><ScanText size={16} /></button>
            <button className="cbtn" onClick={screenshot} disabled={busy} title="Capture a screen region (ask a vision model)"><Crop size={16} /></button>
          </div>

          {/* Ask input — revealed when ? is tapped. */}
          {typing && (
            <div className="ask-row">
              <input
                ref={typeInputRef}
                className="ask-input"
                placeholder="Ask anything about the selection…"
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends. Escape is handled by the document-level keydown listener
                  // (stage-1 closes this input) so we don't double-handle it here.
                  if (e.key === 'Enter' && (freeText.trim() || attachments.length || selection.trim())) { fire({ kind: 'text', selection, sourceApp, freeText: freeText.trim() || undefined }); setTyping(false); }
                }}
              />
              <button
                className="ask-send"
                disabled={busy || !(freeText.trim() || attachments.length || selection.trim())}
                onClick={() => { fire({ kind: 'text', selection, sourceApp, freeText: freeText.trim() || undefined }); setTyping(false); }}
                title="Send"
              ><CornerDownLeft size={14} /></button>
            </div>
          )}

          {/* Preview of what's queued, and where everything surfaces inside the box:
              while working a light travels around the border; when done the response
              fills the box with a small "saved" check; errors show in place. */}
          <div className="preview">
            {attachments.length > 0 && (
              <div className="chips">
                {attachments.map((a) => (
                  <span key={a.path} className="chip" title={a.path}>
                    <Paperclip size={11} />
                    <span className="chip-name">{a.name}</span>
                    <button
                      className="chip-x"
                      onClick={() => setAttachments((prev) => prev.filter((p) => p.path !== a.path))}
                      title="Remove"
                    ><X size={11} /></button>
                  </span>
                ))}
              </div>
            )}
            {(hasSelection || attachments.length === 0 || status !== 'idle') && (
              <div className={`box ${status === 'idle' ? (hasSelection ? 'has-sel' : 'is-empty') : 'active'} s-${status}`}>
                {status === 'running' && openBtn(false)}
                {status === 'done' && openBtn(true)}
                {status === 'idle' && hasSelection && (
                  <button
                    className="box-copy"
                    onClick={copySelection}
                    title={copied ? 'Copied' : 'Copy selection'}
                  >{copied ? <Check size={14} /> : <Copy size={14} />}</button>
                )}

                {status === 'running' ? (
                  <div className="sel-hint"><span className="working">Working…</span></div>
                ) : status === 'error' ? (
                  <div className="sel-hint">{error}</div>
                ) : status === 'done' ? (
                  <div className="sel-text">{answer || 'Saved to your notebook.'}</div>
                ) : hasSelection ? (
                  <div className="sel-text">{selection}</div>
                ) : (
                  <div className="sel-hint">No text selected. Select text in any app, attach a file, or tap ? to ask.</div>
                )}

                {status === 'done' && (
                  <div className="box-status">
                    <span className="saved" title="Saved to notebook"><Check size={14} /></span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<Panel />);
