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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, ReactNodeViewRenderer, type Editor } from '@tiptap/react';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { AiBlock } from './ai-block';
import { AiBlockView } from './ai-block-view';
import { CodeBlockView } from './code-block-view';
import { notebookExtensions, lowlight } from './extensions';
import { markdownToDoc } from './reconstruct';
import { setAiBlockText, setAiBlockAttrs, setAiBlockMarkdown, collectAiBlocks } from './doc-helpers';
import { mergeCommands, filterCommands, type SlashCommand } from '../../main/services/presets/slash-commands';
import type { AIBlockMeta } from '../../main/services/notebook/sidecar';

// The inline-generation slice of window.notebookAPI (preload-notebook.ts).
interface GenerateApi {
  generate: (req: { blockId: string; commandId?: string; freeText?: string; selection?: string; userSelectedModel?: string }) => Promise<{ ok: boolean; error?: string }>;
  /** Aborts all in-flight inline generations in main (added to the preload bridge in parallel). */
  cancelGen?: () => Promise<void>;
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

// Code block with a React NodeView (in-block language dropdown). Extend BEFORE configure so
// the lowlight instance is preserved; reuses the shared lowlight from extensions.ts.
const CodeBlockWithView = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView);
  },
}).configure({ lowlight });

export interface NotebookEditorProps {
  /**
   * Id of the note this editor holds. Saves are keyed to THIS id (not whatever is currently
   * selected), so a debounced save that fires after the user switched notes still writes to
   * the note it came from — never the newly-selected one.
   */
  noteId: string | null;
  /** Initial body as Markdown. */
  markdown: string;
  /** AI-block metadata (from the note's sidecar) used to reconstruct AI blocks on load. */
  aiBlocks?: AIBlockMeta[];
  /** Model id to use for generation (per-note / picker selection). */
  model?: string;
  /** User-defined slash commands (from settings); merged after the built-ins. */
  userCommands?: SlashCommand[];
  /**
   * Called (debounced/flushed) when the body changes, with the owning note id, current
   * Markdown, and the AI blocks now in the doc (so the parent can persist the sidecar).
   */
  onChange?: (noteId: string | null, markdown: string, aiBlocks: Array<Omit<AIBlockMeta, 'createdAt'>>) => void;
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

export function NotebookEditor({ noteId, markdown, aiBlocks = [], model, userCommands = [], onChange, onEditorReady }: NotebookEditorProps) {
  const [menu, setMenu] = useState<MenuState>(CLOSED);
  const buffers = useRef<Map<string, string>>(new Map());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest un-persisted body + AI blocks; held so we can flush them on unmount (note switch /
  // view change / notch capture) instead of dropping the last <400ms of edits with the timer.
  const pendingMarkdown = useRef<string | null>(null);
  const pendingBlocks = useRef<Array<Omit<AIBlockMeta, 'createdAt'>>>([]);
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

  // Reconstruct the initial doc (AI blocks rebuilt from the sidecar) ONCE per mount — this
  // editor remounts per note, so the mount-time markdown/aiBlocks are the note's. markdownToDoc
  // spins up a throwaway parser, so it must not run on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialContent = useMemo(() => markdownToDoc(markdown, aiBlocks), []);

  // Persist immediately, cancelling any pending debounce. Called on every note switch/unmount.
  const flushSave = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (pendingMarkdown.current != null) {
      onChangeRef.current?.(noteIdRef.current, pendingMarkdown.current, pendingBlocks.current);
      pendingMarkdown.current = null;
    }
  }, []);

  const editor = useEditor({
    // One shared schema for the live editor + the headless parse/serialize paths, with the
    // React NodeView spliced in for the AI block. Reconstruct AI blocks from the sidecar on
    // load (their anchors don't survive a plain markdown parse — see reconstruct.ts).
    extensions: notebookExtensions({ aiBlock: AiBlockWithView, codeBlock: CodeBlockWithView }),
    content: initialContent,
    onUpdate: ({ editor }) => {
      if (onChangeRef.current) {
        const md = editor.getMarkdown();
        const blocks = collectAiBlocks(editor);
        const id = noteIdRef.current;
        pendingMarkdown.current = md;
        pendingBlocks.current = blocks;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          pendingMarkdown.current = null;
          onChangeRef.current?.(id, md, blocks);
        }, 400);
      }
      detectSlash();
    },
    onSelectionUpdate: () => detectSlash(),
  });

  // Flush any pending body when this editor unmounts (note switch, view change, capture). The
  // orphaned timer would otherwise fire post-unmount; flushing here saves those edits, keyed to
  // this editor's own noteId. Also abort any in-flight inline generation: this editor is keyed
  // per note, so on unmount its blocks are gone — an un-cancelled run's gen-done would otherwise
  // misroute into the newly-mounted editor and trigger a spurious cross-note save.
  useEffect(() => () => { flushSave(); genApi().cancelGen?.(); }, [flushSave]);

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
    // Explicit highlight wins; otherwise run the command on the note's text ABOVE the `/`, so
    // `/explain` under a paragraph explains that paragraph instead of sending an empty selection
    // (which makes the model just riff on the command word). menu.from is the `/` position.
    const highlighted = sel.empty ? '' : state.doc.textBetween(sel.from, sel.to, '\n');
    const selection = highlighted || state.doc.textBetween(0, menu.from, '\n').trim();
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
      const applied = setAiBlockMarkdown(editor, blockId, answer || (buffers.current.get(blockId) ?? ''));
      buffers.current.delete(blockId);
      // Block not found → it belongs to another note (this run started elsewhere and got
      // misrouted here, or the block was deleted mid-stream). setAiBlockMarkdown was a no-op,
      // so DON'T save — writing now would clobber this note with the wrong note's content.
      if (!applied) return;
      setAiBlockAttrs(editor, blockId, { state: 'done', model: m });
      // A completed AI block is a real edit — persist it now (also clears any pending debounce).
      pendingMarkdown.current = null;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      onChangeRef.current?.(noteIdRef.current, editor.getMarkdown(), collectAiBlocks(editor));
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
