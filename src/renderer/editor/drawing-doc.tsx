// A standalone drawing DOCUMENT (a note with source_kind=drawing): a full-canvas Excalidraw that
// fills the main content area (where notes/chats render) and AUTOSAVES as you draw. There is no
// Cancel/Done — it's a live surface like the chat view, not the modal the in-note drawings use.
//
// Persistence reuses the exact in-note drawing pipeline, keyed by drawingId = noteId:
//   scene JSON  ->  the note's <id>.draw.json sidecar (one drawing, id = noteId)
//   flattened PNG -> images/draw-<noteId>.png
//   note body    -> the same viewable `<!--draw:id-->\n![drawing](…png)` anchor, so the raw .md
//                   still shows the picture in any Markdown viewer.
//
// Lazy-loaded (notebook.tsx wraps it in React.lazy) so Excalidraw stays in its own webpack chunk.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Excalidraw, exportToBlob, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

// Minimal shape of the Excalidraw imperative API — just the getters we read on save (declared
// locally so we don't depend on Excalidraw's deep internal type paths, which move between versions).
interface ExApi {
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
}

interface DrawDocApi {
  getNote: (id: string) => Promise<{ drawings?: Array<{ drawingId: string; scene: unknown }> } | null>;
  updateBody: (id: string, body: string, aiBlocks?: unknown, drawings?: Array<{ drawingId: string; scene: unknown; png?: string }>) => Promise<void>;
}
function api(): DrawDocApi { return (window as unknown as { notebookAPI: DrawDocApi }).notebookAPI; }

// Don't fetch assets over the network (blocked by CSP); resolve within the app origin instead.
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/';

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export default function DrawingDoc({ noteId, onSaved }: { noteId: string; onSaved?: () => void }) {
  const apiRef = useRef<ExApi | null>(null);
  const [initialScene, setInitialScene] = useState<unknown>(undefined); // undefined = still loading
  const lastSaved = useRef<string>('');   // serialized scene we last persisted (skip no-op saves)
  const hydrated = useRef(false);         // first onChange is the load echo — baseline it, don't save
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteRef = useRef(noteId);
  noteRef.current = noteId;

  // Load the stored scene for THIS note once (keyed by drawingId = noteId).
  useEffect(() => {
    let alive = true;
    setInitialScene(undefined);
    hydrated.current = false;
    api().getNote(noteId).then((n) => {
      if (!alive) return;
      const scene = n?.drawings?.find((d) => d.drawingId === noteId)?.scene ?? null;
      setInitialScene(scene);
    }).catch(() => { if (alive) setInitialScene(null); });
    return () => { alive = false; };
  }, [noteId]);

  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

  const persist = useCallback(async () => {
    const ex = apiRef.current;
    if (!ex) return;
    try {
      const id = noteRef.current;
      const elements = ex.getSceneElements() as never;
      const appState = ex.getAppState() as never;
      const files = ex.getFiles() as never;
      // serializeAsJSON strips volatile appState (collaborators, cursors) → a clean, re-openable scene.
      const scene = JSON.parse(serializeAsJSON(elements, appState, files, 'local'));
      const blob = await exportToBlob({ elements, appState, files, mimeType: 'image/png' });
      const png = await blobToDataUrl(blob);
      // Same viewable anchor+image the in-note drawings write, so the raw .md still shows the PNG.
      const body = `<!--draw:${id}-->\n![drawing](images/draw-${id}.png)`;
      await api().updateBody(id, body, undefined, [{ drawingId: id, scene, png }]);
      onSaved?.();
    } catch { /* canvas torn down mid-flush, or export failed — nothing to save */ }
  }, [onSaved]);

  // Excalidraw fires onChange on every edit; debounce, and skip when the serialized scene is
  // unchanged — the initial load echo and pure selection/pan/zoom changes don't need a save + a
  // PNG export. ponytail: serialize-per-change is the simplest correct dirty check; if huge
  // scenes stutter while dragging, gate on a cheaper signal (element count + a version bump).
  const onChange = useCallback(() => {
    const ex = apiRef.current;
    if (!ex) return;
    const ser = serializeAsJSON(ex.getSceneElements() as never, ex.getAppState() as never, ex.getFiles() as never, 'local');
    // First onChange after mount is Excalidraw echoing the loaded (or empty) scene — record it as
    // the baseline and don't save. Real edits after that differ from the baseline and persist.
    if (!hydrated.current) { hydrated.current = true; lastSaved.current = ser; return; }
    if (ser === lastSaved.current) return;
    lastSaved.current = ser;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void persist(); }, 700);
  }, [persist]);

  // Flush a pending save when leaving the doc (note switch / unmount) so the last strokes aren't lost.
  useEffect(() => () => { if (saveTimer.current) { clearTimeout(saveTimer.current); void persist(); } }, [persist]);

  if (initialScene === undefined) return <div className="draw-doc draw-doc--loading">Loading canvas…</div>;
  return (
    <div className="draw-doc">
      <Excalidraw
        theme={theme}
        initialData={(initialScene as never) ?? undefined}
        onChange={onChange as never}
        excalidrawAPI={(a) => { apiRef.current = a as unknown as ExApi; }}
      />
    </div>
  );
}
