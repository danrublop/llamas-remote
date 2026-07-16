import React, { useEffect, useRef, useState, useCallback } from 'react';
import { BrandIcon } from './model-icon';
import { parseEdits, stripEdits, applyEdits } from './note-chat-edits';

// Note-side AI panel: an aside chat that has the CURRENT note as context and can edit it in place.
// The transcript is ephemeral (never saved into the note) — it resets when you switch notes or
// close the panel. Editing goes through the FIND/REPLACE protocol (note-chat-edits.ts): the model
// proposes blocks, the user clicks Apply, and the new Markdown is set back into the live editor.
// Streaming mirrors chat-view's XSS-safe path (createTextNode, never innerHTML) — output is untrusted.

interface Turn { role: 'user' | 'assistant'; content: string }
const MODEL_KEY = 'nb-notechat-model';

const Ico = {
  up: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="6 11 12 5 18 11" /></svg>,
  stop: <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2.5" /></svg>,
  chev: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>,
  close: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>,
  edit: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>,
};

export function NoteChatPanel({ noteId, getMarkdown, onApply, onClose }: {
  noteId: string;
  getMarkdown: () => string;
  onApply: (md: string) => void;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  // '' means "let main pick" — it resolves to the default TEXT model. Never seed this from the
  // note's own `model`: that's the model that produced the note, so an image-captured note would
  // aim this text chat at a vision model (llava), which 500s on a long text prompt.
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) || '');
  const [modelOpen, setModelOpen] = useState(false);
  const [applied, setApplied] = useState<Record<number, string>>({}); // turn index → feedback
  const [width, setWidth] = useState(() => { const v = parseInt(localStorage.getItem('nb-notechat-w') || '', 10); return Number.isFinite(v) && v >= 280 && v <= 760 ? v : 380; });
  const widthRef = useRef(width);
  widthRef.current = width;
  const streamRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const modelPickRef = useRef<HTMLDivElement>(null);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  const scrollDown = () => requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; });

  // Ephemeral: switching notes starts a fresh conversation about the new note.
  useEffect(() => { setTurns([]); setStreaming(false); setError(''); setApplied({}); if (streamRef.current) streamRef.current.textContent = ''; }, [noteId]);
  useEffect(() => { window.settingsAPI.listModels().then(setModels).catch(() => {}); }, []);

  useEffect(() => {
    const offTok = window.notebookAPI.onNoteChatToken((p) => {
      if (p.noteId !== noteIdRef.current || !streamRef.current) return;
      streamRef.current.appendChild(document.createTextNode(p.delta)); // XSS-safe
      scrollDown();
    });
    const offDone = window.notebookAPI.onNoteChatDone((p) => {
      if (p.noteId !== noteIdRef.current) return;
      if (streamRef.current) streamRef.current.textContent = '';
      setTurns([...turnsRef.current, { role: 'assistant', content: p.answer }]);
      setStreaming(false);
      scrollDown();
    });
    const offErr = window.notebookAPI.onNoteChatError((p) => {
      if (p.noteId !== noteIdRef.current) return;
      setStreaming(false); setError(p.error);
    });
    return () => { offTok(); offDone(); offErr(); };
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setError(''); setInput('');
    const history = [...turns, { role: 'user' as const, content: text }];
    setTurns(history);
    setStreaming(true);
    scrollDown();
    try {
      const res = await window.notebookAPI.noteChatSend({ noteId, model: model || undefined, noteMarkdown: getMarkdown(), history });
      if (!res?.ok && res?.error !== 'cancelled') { setStreaming(false); setError(res?.error || 'The model returned nothing.'); }
    } catch (e) {
      // An invoke that rejects (no handler, a throw before the handler's own try, a dead main
      // process) used to land here as an unhandled rejection — leaving `streaming` true and the
      // panel spinning forever with nothing to read. Always surface it instead.
      setStreaming(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function stop() { window.notebookAPI.noteChatAbort(noteId); setStreaming(false); if (streamRef.current) streamRef.current.textContent = ''; }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  const pickModel = (m: string) => { setModel(m); localStorage.setItem(MODEL_KEY, m); setModelOpen(false); };

  // Drag the panel's left edge to resize (width grows leftward, so width = innerWidth − cursorX).
  function startResize(e: React.MouseEvent) {
    e.preventDefault();
    document.body.classList.add('resizing');
    const onMove = (ev: MouseEvent) => { const w = Math.min(760, Math.max(280, window.innerWidth - ev.clientX)); widthRef.current = w; setWidth(w); };
    const onUp = () => {
      document.body.classList.remove('resizing');
      localStorage.setItem('nb-notechat-w', String(Math.round(widthRef.current)));
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('blur', onUp);
    };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); window.addEventListener('blur', onUp);
  }

  function apply(i: number, content: string) {
    const edits = parseEdits(content);
    if (!edits.length) return;
    const r = applyEdits(getMarkdown(), edits);
    onApply(r.md);
    setApplied((a) => ({ ...a, [i]: r.failed ? `Applied ${r.applied}, ${r.failed} not found` : `Applied ${r.applied} edit${r.applied === 1 ? '' : 's'}` }));
  }

  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => { if (modelPickRef.current && !modelPickRef.current.contains(e.target as Node)) setModelOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [modelOpen]);

  return (
    <aside className="note-chat-panel" style={{ width }}>
      <div className="ncp-resizer" onMouseDown={startResize} title="Drag to resize" />
      <button className="ncp-close" onClick={onClose} title="Close">{Ico.close}</button>
      <div className="chat-scroll" ref={scrollRef}>
        {turns.length === 0 && !streaming && (
          <div className="chat-empty ncp-empty">
            <span>Ask about this note, or tell me to edit it — I can rewrite, add, or clean up your work.</span>
          </div>
        )}
        {turns.map((t, i) => {
          const edits = t.role === 'assistant' ? parseEdits(t.content) : [];
          const prose = edits.length ? stripEdits(t.content) : t.content;
          return (
            <div key={i} className={`chat-msg ${t.role}`}>
              {prose && <div className="chat-text">{prose}</div>}
              {edits.length > 0 && (
                <div className="ncp-edit">
                  <span className="ncp-edit-label">{Ico.edit} {edits.length} edit{edits.length === 1 ? '' : 's'} to this note</span>
                  {applied[i]
                    ? <span className="ncp-applied">{applied[i]}</span>
                    : <button className="ncp-apply" onClick={() => apply(i, t.content)}>Apply to note</button>}
                </div>
              )}
            </div>
          );
        })}
        {streaming && <div className="chat-msg assistant"><div className="chat-text streaming" ref={streamRef} /></div>}
        {error && <div className="chat-error">{error}</div>}
      </div>

      <div className="chat-dock">
        <div className={`chat-box${input.trim() || streaming ? ' active' : ''}`}>
          <textarea
            className="chat-input"
            value={input}
            placeholder="Ask or edit…"
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
              {streaming
                ? <button className="chat-send" onClick={stop} title="Stop">{Ico.stop}</button>
                : <button className="chat-send" onClick={send} disabled={!input.trim()} title="Send (Enter)">{Ico.up}</button>}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
