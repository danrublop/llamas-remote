// React NodeView for a drawing: a PNG preview the user double-clicks (or clicks "Edit") to
// reopen the full Excalidraw canvas. An empty drawing (freshly inserted, no scene yet) shows a
// placeholder prompting the first edit.
//
// The preview image is either the transient `png` attr (set just after an edit, for instant
// feedback) or, after a reload, the on-disk PNG fetched via IPC by drawingId. This file renders
// only in the live editor; the headless serializer never mounts NodeViews (drawing.ts stays
// React-free), and Excalidraw itself lives only in the lazy-loaded modal.

import React, { useEffect, useState } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

interface DrawApi { getDrawImage: (id: string) => Promise<string | null>; }
function drawApi(): DrawApi { return (window as unknown as { notebookAPI: DrawApi }).notebookAPI; }

export function DrawingView({ node, editor, selected }: NodeViewProps) {
  const drawingId = String(node.attrs.drawingId ?? '');
  const attrPng = (node.attrs.png as string | null) ?? null;
  const hasScene = !!node.attrs.scene;
  const [diskPng, setDiskPng] = useState<string | null>(null);

  // On reload the node has a scene but no transient png — pull the flattened PNG off disk.
  useEffect(() => {
    if (attrPng || !drawingId || !hasScene) return;
    let alive = true;
    drawApi().getDrawImage(drawingId).then((d) => { if (alive) setDiskPng(d); }).catch(() => {});
    return () => { alive = false; };
  }, [drawingId, attrPng, hasScene]);

  const preview = attrPng ?? diskPng;
  const edit = () => {
    const handler = (editor.storage as { drawing?: { onEdit?: (id: string) => void } }).drawing?.onEdit;
    handler?.(drawingId);
  };

  return (
    <NodeViewWrapper
      className={`drawing${selected ? ' drawing--selected' : ''}`}
      data-drawing-id={drawingId}
      onDoubleClick={edit}
    >
      {preview
        ? <img className="drawing__img" src={preview} alt="drawing" draggable={false} />
        : <div className="drawing__empty">✏️ {hasScene ? 'Drawing' : 'Empty drawing'}</div>}
      <button type="button" className="drawing__edit" contentEditable={false} onClick={edit}>
        {preview || hasScene ? 'Edit' : 'Draw'}
      </button>
    </NodeViewWrapper>
  );
}
