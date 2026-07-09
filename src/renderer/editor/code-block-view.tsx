// React NodeView for a code block: the syntax-highlighted code (NodeViewContent, still
// decorated by lowlight) with a per-block language dropdown in the top-right — so the
// language lives ON the block (Notion/Google-Docs style) instead of in the global toolbar.
//
// NOTE: renders only in the live React editor; the headless serializer never mounts
// NodeViews, so the plain CodeBlockLowlight node still drives markdown round-tripping.

import React from 'react';
import { NodeViewWrapper, NodeViewContent, type NodeViewProps } from '@tiptap/react';
import { CODE_LANGS } from './code-langs';

export function CodeBlockView({ node, updateAttributes }: NodeViewProps) {
  const lang = String(node.attrs.language || 'plaintext');
  return (
    <NodeViewWrapper className="cb">
      <select
        className="cb-lang"
        contentEditable={false}
        value={lang}
        // stop the editor from stealing the pointer / selection when using the dropdown
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => updateAttributes({ language: e.target.value })}
        title="Code language"
      >
        {CODE_LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
      {/* as="code" is correct; NodeViewContent's `as` is NoInfer-pinned to 'div', so cast. */}
      <pre><NodeViewContent as={'code' as unknown as 'div'} /></pre>
    </NodeViewWrapper>
  );
}
