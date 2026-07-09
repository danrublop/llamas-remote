// NotebookEditor: the TipTap-based note editor with inline `/` generation.
//
// Additive component — not yet swapped into notebook.tsx. Verify with `npm run dev` before
// replacing the contentEditable editor.
//
//   user types `/` -> slash menu (filterCommands) -> pick -> insert empty AiBlock(blockId)
//        |                                                         |
//        +- selection text ----------------------------------------+
//   notebookAPI.generate({blockId, commandId, selection}) -> onGen* (by blockId) ->
//        setAiBlockText(cumulative) / setAiBlockAttrs(state)   [see doc-helpers.ts]
//
// Markdown is the on-disk format: load via setContent(md, markdown), save via getMarkdown().

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, ReactNodeViewRenderer, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import { Highlight } from '@tiptap/extension-highlight';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';

// Syntax highlighting for code blocks — `common` bundles ~37 languages (java, js, python, …).
const lowlight = createLowlight(common);

// Markdown has no syntax for text color / highlight, so we serialize those marks to inline
// HTML (`<span style="color">`, `<mark style="background-color">`) — which the marks'
// parseHTML rebuilds on load, so color + highlight survive the on-disk Markdown round-trip.
// Only these registered marks are reconstructed from the HTML, so it stays XSS-safe.
// The serializer passes the mark's attrs directly on `node.attrs`.
// Only emit a color we can prove is a plain CSS color. The Color mark's parseHTML
// CSS-normalizes + strips quotes, but Highlight's parseHTML reads `data-color` RAW —
// so untrusted on-disk Markdown (model/clipboard output) could round-trip an
// unescaped value into `node.attrs.color`. Allowlisting hex / rgb() / hsl() / a bare
// name keeps the serialized `<span>`/`<mark>` HTML injection-free even on export.
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,\s%/]+\)$|^hsla?\([\d.,\s%/]+\)$|^[a-zA-Z]{1,32}$/;
const markColor = (node: unknown): string | undefined => {
  const c = (node as { attrs?: { color?: string } })?.attrs?.color?.trim();
  return c && SAFE_COLOR.test(c) ? c : undefined;
};

const TextStyleMd = TextStyle.extend({
  renderMarkdown(node: unknown, { renderChildren }: { renderChildren: () => string }) {
    const color = markColor(node);
    const inner = renderChildren();
    return color ? `<span style="color: ${color}">${inner}</span>` : inner;
  },
} as never);

const HighlightMd = Highlight.extend({
  renderMarkdown(node: unknown, { renderChildren }: { renderChildren: () => string }) {
    const color = markColor(node);
    const inner = renderChildren();
    return color ? `<mark style="background-color: ${color}">${inner}</mark>` : `<mark>${inner}</mark>`;
  },
} as never);
import { AiBlock } from './ai-block';
import { AiBlockView } from './ai-block-view';
import { setAiBlockText, setAiBlockAttrs, setAiBlockMarkdown } from './doc-helpers';
import { mergeCommands, filterCommands, type SlashCommand } from '../../main/services/presets/slash-commands';

// The inline-generation slice of window.notebookAPI (preload-notebook.ts).
interface GenerateApi {
  generate: (req: { blockId: string; commandId?: string; freeText?: string; selection?: string; userSelectedModel?: string }) => Promise<{ ok: boolean; error?: string }>;
  onGenStart: (cb: (p: { blockId: string; model: string }) => void) => () => void;
  onGenToken: (cb: (p: { blockId: string; delta: string }) => void) => () => void;
  onGenDone: (cb: (p: { blockId: string; answer: string; model: string }) => void) => () => void;
  onGenError: (cb: (p: { blockId: string; message: string }) => void) => () => void;
}
function genApi(): GenerateApi {
  return (window as unknown as { notebookAPI: GenerateApi }).notebookAPI;
}

const AiBlockWithView = AiBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(AiBlockView);
  },
});

export interface NotebookEditorProps {
  /**
   * Id of the note this editor holds. Saves are keyed to THIS id (not whatever is currently
   * selected), so a debounced save that fires after the user switched notes still writes to
   * the note it came from — never the newly-selected one.
   */
  noteId: string | null;
  /** Initial body as Markdown. */
  markdown: string;
  /** Model id to use for generation (per-note / picker selection). */
  model?: string;
  /** User-defined slash commands (from settings); merged after the built-ins. */
  userCommands?: SlashCommand[];
  /** Called (debounced) when the body changes, with the owning note id + current Markdown. */
  onChange?: (noteId: string | null, markdown: string) => void;
  /** Receives the live editor instance (for parent-rendered toolbar controls). */
  onEditorReady?: (editor: Editor | null) => void;
}

interface MenuState {
  open: boolean;
  query: string;
  /** caret screen coords for positioning. */
  left: number;
  top: number;
  index: number;
  /** doc position of the `/` that opened the menu. */
  from: number;
}

const CLOSED: MenuState = { open: false, query: '', left: 0, top: 0, index: 0, from: 0 };

export function NotebookEditor({ noteId, markdown, model, userCommands = [], onChange, onEditorReady }: NotebookEditorProps) {
  const [menu, setMenu] = useState<MenuState>(CLOSED);
  const buffers = useRef<Map<string, string>>(new Map());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest un-persisted body; held so we can flush it on unmount (note switch / view change /
  // notch capture) instead of dropping the last <400ms of edits with the pending timer.
  const pendingMarkdown = useRef<string | null>(null);
  // onChange can change identity (parent useCallback deps) — keep a live ref so the once-created
  // onUpdate closure + unmount flush call the latest one.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // noteId is FROZEN at mount, deliberately not updated on re-render. This editor is a fresh
  // instance per note (parent remounts it via `key`), and `selectedId` flips to the next note
  // BEFORE this instance unmounts — so reading a live prop would misroute the outgoing note's
  // flush into the incoming note. The mount-time id is the note this editor actually holds.
  const noteIdRef = useRef(noteId);
  const commands = mergeCommands(userCommands);
  const results = menu.open ? filterCommands(commands, menu.query, 'text') : [];

  // Persist immediately, cancelling any pending debounce. Called on every note switch/unmount.
  const flushSave = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (pendingMarkdown.current != null) {
      onChangeRef.current?.(noteIdRef.current, pendingMarkdown.current);
      pendingMarkdown.current = null;
    }
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }), // replaced by the syntax-highlighting block below
      Markdown,
      AiBlockWithView,
      TextStyleMd,
      Color,
      HighlightMd.configure({ multicolor: true }),
      CodeBlockLowlight.configure({ lowlight }),
    ],
    content: markdown,
    contentType: 'markdown' as never,
    onUpdate: ({ editor }) => {
      if (onChangeRef.current) {
        const md = editor.getMarkdown();
        const id = noteIdRef.current;
        pendingMarkdown.current = md;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          pendingMarkdown.current = null;
          onChangeRef.current?.(id, md);
        }, 400);
      }
      detectSlash();
    },
    onSelectionUpdate: () => detectSlash(),
  });

  // Flush any pending body when this editor unmounts (note switch, view change, capture). The
  // orphaned timer would otherwise fire post-unmount; flushing here saves those edits, keyed to
  // this editor's own noteId.
  useEffect(() => flushSave, [flushSave]);

  // Hand the live editor up to the parent so its toolbar can drive color / code-block commands.
  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  // ---- slash detection -----------------------------------------------------------------
  const detectSlash = useCallback(() => {
    if (!editor) return;
    const { state } = editor;
    const { $from, empty } = state.selection;
    if (!empty) return setMenu(CLOSED);
    const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
    const m = /(?:^|\s)\/(\S*)$/.exec(textBefore);
    if (!m) return setMenu(CLOSED);
    const query = m[1];
    const slashFrom = $from.pos - query.length - 1; // position of the '/'
    const coords = editor.view.coordsAtPos($from.pos);
    setMenu((prev) => ({ open: true, query, left: coords.left, top: coords.bottom, index: prev.open ? prev.index : 0, from: slashFrom }));
  }, [editor]);

  // ---- run a command -------------------------------------------------------------------
  const runCommand = useCallback((cmd: SlashCommand) => {
    if (!editor) return;
    const { state } = editor;
    const sel = state.selection;
    const selection = sel.empty ? '' : state.doc.textBetween(sel.from, sel.to, '\n');
    const blockId = crypto.randomUUID();

    editor
      .chain()
      .focus()
      .deleteRange({ from: menu.from, to: state.selection.$from.pos })
      .insertContent({
        type: 'aiBlock',
        attrs: { blockId, model: model ?? null, commandId: cmd.id, prompt: cmd.name, selection, state: 'generating' },
        content: [{ type: 'paragraph' }],
      })
      .run();

    setMenu(CLOSED);
    buffers.current.set(blockId, '');
    void genApi().generate({ blockId, commandId: cmd.id, selection, userSelectedModel: model });
  }, [editor, menu.from, model]);

  // ---- re-run (from the NodeView) ------------------------------------------------------
  useEffect(() => {
    if (!editor) return;
    (editor.storage as { aiBlock?: { onRerun?: (id: string) => void } }).aiBlock!.onRerun = (blockId: string) => {
      let attrs: Record<string, unknown> | null = null;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'aiBlock' && node.attrs.blockId === blockId) { attrs = { ...node.attrs }; return false; }
        return true;
      });
      if (!attrs) return;
      const a = attrs as { commandId?: string; selection?: string };
      setAiBlockAttrs(editor, blockId, { state: 'generating' });
      buffers.current.set(blockId, '');
      void genApi().generate({ blockId, commandId: a.commandId, selection: a.selection ?? '', userSelectedModel: model });
    };
  }, [editor, model]);

  // ---- streaming wiring ----------------------------------------------------------------
  useEffect(() => {
    if (!editor) return;
    const api = genApi();
    const offStart = api.onGenStart(({ blockId, model: m }) => {
      buffers.current.set(blockId, '');
      setAiBlockAttrs(editor, blockId, { state: 'generating', model: m });
    });
    const offToken = api.onGenToken(({ blockId, delta }) => {
      const cur = (buffers.current.get(blockId) ?? '') + delta;
      buffers.current.set(blockId, cur);
      setAiBlockText(editor, blockId, cur);
    });
    const offDone = api.onGenDone(({ blockId, answer, model: m }) => {
      // Parse the final answer Markdown into real nodes (lists/headings/code render
      // properly and round-trip to Markdown) instead of leaving it as literal text.
      setAiBlockMarkdown(editor, blockId, answer || (buffers.current.get(blockId) ?? ''));
      setAiBlockAttrs(editor, blockId, { state: 'done', model: m });
      buffers.current.delete(blockId);
      // A completed AI block is a real edit — persist it now (also clears any pending debounce).
      pendingMarkdown.current = null;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      onChangeRef.current?.(noteIdRef.current, editor.getMarkdown());
    });
    const offErr = api.onGenError(({ blockId }) => {
      setAiBlockAttrs(editor, blockId, { state: 'error' });
      buffers.current.delete(blockId);
    });
    return () => { offStart(); offToken(); offDone(); offErr(); };
  }, [editor, onChange]);

  // ---- menu keyboard nav ---------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!menu.open || results.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setMenu((p) => ({ ...p, index: (p.index + 1) % results.length })); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setMenu((p) => ({ ...p, index: (p.index - 1 + results.length) % results.length })); }
    else if (e.key === 'Enter') { e.preventDefault(); runCommand(results[menu.index]); }
    else if (e.key === 'Escape') { e.preventDefault(); setMenu(CLOSED); }
  };

  return (
    <div className="nb-editor" onKeyDown={onKeyDown}>
      <EditorContent editor={editor} className="nb-editor__content" />
      {menu.open && results.length > 0 && (
        <div className="slash-menu" style={{ position: 'fixed', left: menu.left, top: menu.top + 4 }} role="listbox">
          {results.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={i === menu.index}
              className={`slash-item${i === menu.index ? ' is-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); runCommand(c); }}
              onMouseEnter={() => setMenu((p) => ({ ...p, index: i }))}
            >
              <span className="slash-item__name">{c.name}</span>
              {c.source === 'user' && <span className="slash-item__badge">custom</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
