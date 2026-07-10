// The full-screen Excalidraw canvas, shown when a drawing is inserted or double-clicked.
//
// This module is lazy-loaded (NotebookEditor wraps it in React.lazy), so Excalidraw's ~2MB of
// JS/CSS lands in a separate webpack chunk fetched only when a drawing is first opened — the
// base notebook bundle stays lean. On save it hands back BOTH the re-editable scene JSON (for
// the sidecar) and a flattened PNG data-URL (for the images/ file the raw Markdown points at).
//
// CSP note: fonts are served from Excalidraw's CDN by default, which `connect-src 'self'` blocks;
// setting EXCALIDRAW_ASSET_PATH keeps it from reaching out, and text falls back to system fonts.
// Shapes / pen / arrows / colors / eraser / select all work fully offline.

import React, { useRef } from 'react';
import { Excalidraw, exportToBlob, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

// Minimal shape of the Excalidraw imperative API — just the getters we read on save. Declared
// locally so we don't depend on Excalidraw's deep internal type paths (they move between versions).
interface ExApi {
  getSceneElements: () => readonly unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
}

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

export interface DrawingModalProps {
  /** The stored scene to reopen ({ elements, appState, files }), or null for a blank canvas. */
  initialScene: unknown;
  /** User committed the drawing: persist the clean scene + a flattened PNG data-URL. */
  onSave: (scene: unknown, png: string) => void;
  /** Close without saving. */
  onClose: () => void;
}

export default function DrawingModal({ initialScene, onSave, onClose }: DrawingModalProps) {
  const apiRef = useRef<ExApi | null>(null);

  const save = async () => {
    const api = apiRef.current;
    if (!api) return onClose();
    const elements = api.getSceneElements() as never;
    const appState = api.getAppState() as never;
    const files = api.getFiles() as never;
    // serializeAsJSON strips volatile appState (collaborators, cursors) → a clean, re-openable scene.
    const scene = JSON.parse(serializeAsJSON(elements, appState, files, 'local'));
    const blob = await exportToBlob({ elements, appState, files, mimeType: 'image/png' });
    onSave(scene, await blobToDataUrl(blob));
  };

  // Match the notebook's current theme so the canvas isn't a white slab in dark mode.
  const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

  return (
    <div className="draw-overlay">
      <div className="draw-modal" role="dialog" aria-modal="true">
        <div className="draw-modal__bar">
          <span className="draw-modal__title">Drawing</span>
          <button type="button" className="draw-modal__btn" onClick={onClose}>Cancel</button>
          <button type="button" className="draw-modal__btn draw-modal__btn--primary" onClick={() => void save()}>Done</button>
        </div>
        <div className="draw-modal__canvas">
          <Excalidraw
            theme={theme}
            initialData={(initialScene as never) ?? undefined}
            excalidrawAPI={(api) => { apiRef.current = api as unknown as ExApi; }}
          />
        </div>
      </div>
    </div>
  );
}
