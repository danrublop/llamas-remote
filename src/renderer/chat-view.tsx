import React, { useEffect, useRef, useState, useCallback } from 'react';

// Chat surface for a source_kind=chat note: a bubble transcript + a composer with model picker
// and a RAG toggle. Streaming mirrors the notch panel's XSS-safe path — deltas are appended via
// document.createTextNode (never innerHTML), since model output is untrusted.

interface ChatTurn { role: 'user' | 'assistant'; content: string; model?: string; cites?: string[]; ts?: string }
interface NoteRef { id: string; title: string }

const Ico = {
  up: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="6 11 12 5 18 11" /></svg>,
  stop: <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2.5" /></svg>,
  notes: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>,
};

const RAG_KEY = 'nb-chat-rag';
const MODEL_KEY = 'nb-chat-model';

export function ChatView({ noteId, notes, onOpenNote, onTurnsChanged }: {
  noteId: string;
  notes: NoteRef[];
  onOpenNote: (id: string) => void;
  onTurnsChanged?: () => void;
}) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_KEY) || '');
  const [useRag, setUseRag] = useState(() => localStorage.getItem(RAG_KEY) !== 'off');
  const [ragReady, setRagReady] = useState(true); // false → embed model not pulled (falls back to keyword)
  const streamRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

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

  const pickModel = (m: string) => { setModel(m); localStorage.setItem(MODEL_KEY, m); };
  const toggleRag = () => setUseRag((v) => { localStorage.setItem(RAG_KEY, v ? 'off' : 'on'); return !v; });

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        {turns.length === 0 && !streaming && (
          <div className="chat-empty">Ask anything. {useRag ? 'Answers can draw on your notes.' : 'Notes context is off.'}</div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`chat-msg ${t.role}`}>
            <div className="chat-text">{t.content}</div>
            {t.role === 'assistant' && t.cites && t.cites.length > 0 && (
              <div className="chat-cites">
                <span className="chat-cites-label">Sources</span>
                {t.cites.map((id) => (
                  <button key={id} className="chat-cite" onClick={() => onOpenNote(id)} title={`Open “${titleOf(id)}”`}>{titleOf(id)}</button>
                ))}
              </div>
            )}
          </div>
        ))}
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
              <select value={model} onChange={(e) => pickModel(e.target.value)} title="Model" className="chat-model">
                <option value="">Default model</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <button className={`chat-rag${useRag ? ' on' : ''}`} onClick={toggleRag} title={useRag ? 'Using your notes as context' : 'Notes context off'}>
                {Ico.notes} Notes
              </button>
            </div>
            {streaming
              ? <button className="chat-send stop" onClick={stop} title="Stop">{Ico.stop}</button>
              : <button className="chat-send" onClick={send} disabled={!input.trim()} title="Send (Enter)">{Ico.up}</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
