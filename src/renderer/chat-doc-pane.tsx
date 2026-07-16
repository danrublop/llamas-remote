import React, { useEffect, useState } from 'react';
import { NotebookEditor } from './editor/NotebookEditor';

// The companion document beside a chat: a second live NotebookEditor, so the agent and the user
// edit the same note together. It's a real note (persists, shows in the tree, can be moved); this
// just mounts an editor on it. `reloadKey` bumps whenever the agent writes to the note behind the
// pane's back — remounting reloads the fresh body. The user's own typing saves through onChange and
// does NOT bump reloadKey, so it never remounts mid-keystroke.

export function ChatDocPane({ docId, reloadKey, title, onClose, onOpenFull, onSaved }: {
  docId: string;
  reloadKey: number;
  title: string;
  onClose: () => void;
  onOpenFull: () => void;
  onSaved: () => void;
}) {
  const [markdown, setMarkdown] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setMarkdown(null);
    window.notebookAPI.getBody(docId).then((b) => { if (live) setMarkdown(b ?? ''); }).catch(() => { if (live) setMarkdown(''); });
    return () => { live = false; };
  }, [docId, reloadKey]);

  return (
    <aside className="chat-doc-pane">
      <div className="chat-doc-head">
        <span className="chat-doc-title" title={title}>{title || 'Document'}</span>
        <button className="chat-doc-btn" onClick={onOpenFull} title="Open full">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
        </button>
        <button className="chat-doc-btn" onClick={onClose} title="Close">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
      <div className="chat-doc-body">
        {markdown !== null && (
          <NotebookEditor
            key={`${docId}:${reloadKey}`}
            noteId={docId}
            markdown={markdown}
            onChange={(id, md, aiBlocks, drawings) => {
              if (id) window.notebookAPI.updateBody(id, md, aiBlocks, drawings).then(onSaved).catch(() => {});
            }}
          />
        )}
      </div>
    </aside>
  );
}
