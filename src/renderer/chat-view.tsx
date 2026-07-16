import React, { useEffect, useRef, useState, useCallback } from 'react';
import { BrandIcon } from './model-icon';
import { parseCalOps, stripCalOps, describeOp, type CalOp } from './calendar/calendar-ops';
import { parseDocOps, hasDocOps, stripDocOps, describeDocOps } from './note-doc';

// Chat surface for a source_kind=chat note: a bubble transcript + a composer with model picker
// and a RAG toggle. Streaming mirrors the notch panel's XSS-safe path — deltas are appended via
// document.createTextNode (never innerHTML), since model output is untrusted.

interface ChatTurn { role: 'user' | 'assistant'; content: string; model?: string; cites?: string[]; ts?: string }
interface NoteRef { id: string; title: string }

const Ico = {
  up: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="6 11 12 5 18 11" /></svg>,
  stop: <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2.5" /></svg>,
  copy: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>,
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>,
  chev: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>,
  notes: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>,
  app: <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M11.146 15.854a1.207 1.207 0 0 1 1.708 0l1.56 1.56A2 2 0 0 1 15 18.828V21a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-2.172a2 2 0 0 1 .586-1.414z" /><path d="M18.828 15a2 2 0 0 1-1.414-.586l-1.56-1.56a1.207 1.207 0 0 1 0-1.708l1.56-1.56A2 2 0 0 1 18.828 9H21a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1z" /><path d="M6.586 14.414A2 2 0 0 1 5.172 15H3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h2.172a2 2 0 0 1 1.414.586l1.56 1.56a1.207 1.207 0 0 1 0 1.708z" /><path d="M9 3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2.172a2 2 0 0 1-.586 1.414l-1.56 1.56a1.207 1.207 0 0 1-1.708 0l-1.56-1.56A2 2 0 0 1 9 5.172z" /></svg>,
  cal: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>,
  doc: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="14" y2="17" /></svg>,
};

const RAG_KEY = 'nb-chat-rag';
const MODEL_KEY = 'nb-chat-model';

export function ChatView({ noteId, notes, onOpenNote, onTurnsChanged, onApplyCalOps, onChatDoc, onShowDoc }: {
  noteId: string;
  notes: NoteRef[];
  onOpenNote: (id: string) => void;
  onTurnsChanged?: () => void;
  /** Apply the model's proposed calendar changes; resolves with what actually landed. */
  onApplyCalOps?: (ops: CalOp[]) => Promise<{ applied: number; failed: number }>;
  /** The agent wrote/edited the companion document — apply it and open the split pane. */
  onChatDoc?: (content: string) => void;
  /** Reveal the companion document pane (for a chip on an earlier turn). */
  onShowDoc?: () => void;
}) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) || '');
  const [useRag, setUseRag] = useState(() => localStorage.getItem(RAG_KEY) !== 'off');
  const [ragReady, setRagReady] = useState(true); // false → embed model not pulled (falls back to keyword)
  const [modelOpen, setModelOpen] = useState(false);
  const [copied, setCopied] = useState(-1); // index of the turn whose copy just fired
  const [calApplied, setCalApplied] = useState<Record<number, string>>({}); // turn index → result
  const streamRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelPickRef = useRef<HTMLDivElement>(null);
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;
  // Refs so the stream-done subscription (set up once) always calls the latest callbacks.
  const onChatDocRef = useRef(onChatDoc);
  onChatDocRef.current = onChatDoc;

  const titleOf = (id: string) => notes.find((n) => n.id === id)?.title || 'Untitled';
  const scrollDown = () => { requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }); };

  const loadTurns = useCallback(async () => {
    const t = await window.notebookAPI.chatGet(noteId).catch(() => []);
    setTurns(t);
    scrollDown();
  }, [noteId]);

  // Load transcript on note switch; reset live state.
  useEffect(() => { setStreaming(false); setError(''); if (streamRef.current) streamRef.current.textContent = ''; loadTurns(); }, [noteId, loadTurns]);

  useEffect(() => { window.settingsAPI.listModels().then(setModels).catch(() => {}); }, []);
  useEffect(() => { window.notebookAPI.ragStatus().then((s) => setRagReady(s.healthy)).catch(() => {}); }, []);

  // Stream subscriptions (scoped to this note by id).
  useEffect(() => {
    const offTok = window.notebookAPI.onChatToken((p) => {
      if (p.noteId !== noteIdRef.current || !streamRef.current) return;
      streamRef.current.appendChild(document.createTextNode(p.delta)); // XSS-safe: text node, never HTML
      scrollDown();
    });
    const offDone = window.notebookAPI.onChatDone((p) => {
      if (p.noteId !== noteIdRef.current) return;
      if (streamRef.current) streamRef.current.textContent = '';
      setStreaming(false);
      loadTurns();
      onTurnsChanged?.();
      // Companion document: apply once here (not per-render) so the split pane updates live.
      if (p.answer && hasDocOps(parseDocOps(p.answer))) onChatDocRef.current?.(p.answer);
    });
    const offErr = window.notebookAPI.onChatError((p) => {
      if (p.noteId !== noteIdRef.current) return;
      setStreaming(false); setError(p.error);
    });
    return () => { offTok(); offDone(); offErr(); };
  }, [loadTurns, onTurnsChanged]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setError('');
    setInput('');
    // Optimistically show the user turn; the transcript reload on done makes it authoritative.
    setTurns((t) => [...t, { role: 'user', content: text }]);
    setStreaming(true);
    scrollDown();
    const res = await window.notebookAPI.chatSend({ noteId, text, model: model || undefined, useRag });
    if (!res.ok && res.error && res.error !== 'cancelled') { setStreaming(false); setError(res.error); }
  }

  function stop() { window.notebookAPI.chatAbort(noteId); setStreaming(false); if (streamRef.current) streamRef.current.textContent = ''; loadTurns(); }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  const pickModel = (m: string) => { setModel(m); localStorage.setItem(MODEL_KEY, m); setModelOpen(false); };
  const toggleRag = () => setUseRag((v) => { localStorage.setItem(RAG_KEY, v ? 'off' : 'on'); return !v; });

  async function applyOps(i: number, ops: CalOp[]) {
    if (!onApplyCalOps) return;
    const r = await onApplyCalOps(ops).catch(() => null);
    // Say what actually happened: an op naming an event that isn't there is reported, not hidden.
    setCalApplied((a) => ({
      ...a,
      [i]: !r ? "Couldn't reach the calendar"
        : r.failed ? `Applied ${r.applied}, ${r.failed} didn't match an event`
        : `Applied ${r.applied} change${r.applied === 1 ? '' : 's'}`,
    }));
  }

  async function copyTurn(i: number, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(i); setTimeout(() => setCopied((c) => (c === i ? -1 : c)), 1500); } catch { /* clipboard denied */ }
  }

  // Close the model dropdown on an outside click.
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => { if (modelPickRef.current && !modelPickRef.current.contains(e.target as Node)) setModelOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modelOpen]);

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        {turns.length === 0 && !streaming && (
          <div className="chat-empty">
            <span className="chat-empty-glyph">{Ico.app}</span>
            <span>Ask anything. {useRag ? 'Answers can draw on your notes.' : 'Notes context is off.'}</span>
          </div>
        )}
        {turns.map((t, i) => {
          // Calendar ops + companion-document ops the model proposed. The blocks are protocol, not
          // prose, so they come out of the displayed text: calendar renders an apply card, the
          // document was already applied to the split pane and renders a chip that reveals it.
          const ops = t.role === 'assistant' ? parseCalOps(t.content) : [];
          const docOps = t.role === 'assistant' ? parseDocOps(t.content) : null;
          const showDoc = !!docOps && hasDocOps(docOps);
          let body = t.content;
          if (ops.length) body = stripCalOps(body);
          if (showDoc) body = stripDocOps(body);
          return (
          <div key={i} className={`chat-msg ${t.role}`}>
            {body && <div className="chat-text">{body}</div>}
            {showDoc && (
              <button className="chat-doc-chip" onClick={onShowDoc} title="Open the document">
                {Ico.doc} {describeDocOps(docOps)}
              </button>
            )}
            {ops.length > 0 && (
              <div className="chat-cal">
                <div className="chat-cal-head">{Ico.cal} {ops.length} calendar change{ops.length === 1 ? '' : 's'}</div>
                <ul className="chat-cal-list">
                  {ops.map((op, j) => <li key={j}>{describeOp(op)}</li>)}
                </ul>
                {calApplied[i]
                  ? <span className="chat-cal-done">{calApplied[i]}</span>
                  : <button className="chat-cal-apply" onClick={() => applyOps(i, ops)}>Apply to calendar</button>}
              </div>
            )}
            {t.role === 'assistant' && t.cites && t.cites.length > 0 && (
              <div className="chat-cites">
                <span className="chat-cites-label">Sources</span>
                {t.cites.map((id) => (
                  <button key={id} className="chat-cite" onClick={() => onOpenNote(id)} title={`Open “${titleOf(id)}”`}>{titleOf(id)}</button>
                ))}
              </div>
            )}
            {t.role === 'assistant' && (
              <div className="chat-actions">
                <button className="chat-copy" onClick={() => copyTurn(i, t.content)} title={copied === i ? 'Copied' : 'Copy response'}>
                  {copied === i ? Ico.check : Ico.copy}
                </button>
              </div>
            )}
          </div>
          );
        })}
        {streaming && (
          <div className="chat-msg assistant">
            <div className="chat-text streaming" ref={streamRef} />
          </div>
        )}
        {error && <div className="chat-error">{error}</div>}
        {useRag && !ragReady && (
          <div className="chat-hint">Semantic notes search needs <code>ollama pull nomic-embed-text</code> — using keyword search until then.</div>
        )}
      </div>

      <div className="chat-dock">
        <div className={`chat-box${input.trim() || streaming ? ' active' : ''}`}>
          <textarea
            className="chat-input"
            value={input}
            placeholder="Message…"
            rows={1}
            onChange={(e) => { setInput(e.target.value); const el = e.target; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; }}
            onKeyDown={onKey}
          />
          <div className="chat-bar">
            <div className="chat-bar-left">
              <div className="chat-model-pick" ref={modelPickRef}>
                <button className="chat-model" onClick={() => setModelOpen((v) => !v)} title="Model">
                  {model ? <BrandIcon model={model} size={15} /> : <span className="chat-model-dot" />}
                  <span className="chat-model-name">{model || 'Default model'}</span>
                  {Ico.chev}
                </button>
                {modelOpen && (
                  <div className="chat-model-menu">
                    <button className={`chat-model-opt${model === '' ? ' on' : ''}`} onClick={() => pickModel('')}>
                      <span className="chat-model-dot" /><span className="chat-model-name">Default model</span>
                    </button>
                    {models.map((m) => (
                      <button key={m} className={`chat-model-opt${m === model ? ' on' : ''}`} onClick={() => pickModel(m)}>
                        <BrandIcon model={m} size={15} /><span className="chat-model-name">{m}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="chat-bar-right">
              <button className={`chat-rag${useRag ? ' on' : ''}`} onClick={toggleRag} title={useRag ? 'Using your notes as context' : 'Notes context off'}>
                {Ico.notes}
              </button>
              {streaming
                ? <button className="chat-send" onClick={stop} title="Stop">{Ico.stop}</button>
                : <button className="chat-send" onClick={send} disabled={!input.trim()} title="Send (Enter)">{Ico.up}</button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
