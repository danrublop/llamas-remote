// React NodeView for a CalendarEvent: a colored container box with inline-editable title + time
// and a color picker, plus a delete button. Renders only in the live editor; the headless
// serializer uses the plain node (markdown round-trip needs no React).

import React from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

export function EventView({ node, updateAttributes, deleteNode, editor }: NodeViewProps) {
  const { title, start, end, color } = node.attrs as { title: string; start: string; end: string; color: string };
  return (
    <NodeViewWrapper className="ev-box" contentEditable={false} style={{ ['--ev-color' as string]: color }}>
      {/* The colour bar doubles as the drag handle — the node is draggable, but every other part of
          the box is an input that needs its own mousedown. */}
      <span className="ev-bar" data-drag-handle draggable title="Drag to move this event" style={{ background: color }} />
      <div className="ev-main">
        <div className="ev-row">
          <input
            className="ev-title" placeholder="Event title" value={title}
            onChange={(e) => updateAttributes({ title: e.target.value })}
            onMouseDown={(e) => e.stopPropagation()}
          />
          {/* Native time fields: click each segment, type digits, press a/p for AM/PM. */}
          <span className="ev-times" onMouseDown={(e) => e.stopPropagation()}>
            <input className="ev-time" type="time" value={start} aria-label="Start time" onChange={(e) => updateAttributes({ start: e.target.value })} />
            <span className="ev-dash">–</span>
            <input className="ev-time" type="time" value={end} aria-label="End time" onChange={(e) => updateAttributes({ end: e.target.value })} />
          </span>
        </div>
        <div className="ev-colors">
          {COLORS.map((c) => (
            <button key={c} className={`ev-swatch${c === color ? ' on' : ''}`} style={{ background: c }}
              onMouseDown={(e) => e.stopPropagation()} onClick={() => updateAttributes({ color: c })} title={c} />
          ))}
          {/* Delete is an ordinary editor transaction, so ⌘Z undoes it — but only if the editor has
              focus, and clicking × leaves it on a button that's about to vanish. So take it back. */}
          <button
            className="ev-del" onMouseDown={(e) => e.stopPropagation()} title="Delete event"
            onClick={() => { deleteNode(); editor.commands.focus(); }}
          >×</button>
        </div>
      </div>
    </NodeViewWrapper>
  );
}
