# CLAUDE.md

Guidance for working in this repo.

## What this is

**Llamas Remote** — an Electron + React + TypeScript macOS app. A Dynamic-Island-style notch
panel captures the current selection (or a screen region), asks a local/cloud LLM, and streams
the answer into a searchable Markdown notebook.

History: this repo was previously "Code Explainer" / "i cant code" (a Mistral code-explanation
popup). It pivoted to the notch/notebook product. Pre-pivot docs and dead services were removed;
if you find references to the old names, they are stale.

## Commands

```bash
npm run dev      # build main + watch renderer + launch electron
npm run build    # compile main (tsc) + renderer (webpack)
npm run dist:mac # package a universal macOS dmg/zip
```

## Testing

- Framework: **vitest**. Run: `npm test` (CI) or `npm run test:watch`.
- Tests live next to the code as `*.test.ts` under `src/main/services`.
- The service layer is designed for headless unit tests: dependencies (capture provider, LLM
  client, clock, id, clipboard) are injected, so the core flow runs without Electron or Ollama.
- `sqlite-index.ts` is **not** unit-tested (native module built for the Electron ABI); the store
  logic is tested through an in-memory fake index (`memory-index.ts`). Verify SQLite at runtime.

## Architecture map

```
src/main/
  main.ts                       window / tray / global-shortcut / IPC glue (runtime only)
  services/
    capture/                    on-demand selection capture (selection-hook AXAPI → synthetic Cmd+C fallback)
    vision/screenshot.ts        screencapture -i region grab
    vision/ocr.ts               on-device OCR (no model) via the bundled Vision helper (build-resources/ocr.swift)
    llm/                        MultiLlmClient routes by model id → ollama | openai | anthropic
                                (+ stream-error.ts: shared provider error-body reader)
    notch/notch-controller.ts   orchestration: build prompt → route model → stream → save
    notch/stream-session.ts     streaming lifecycle: readiness queue + request-id + AbortSignal
    router/model-router.ts      pure model-selection precedence (+ vision capability)
    models/model-capability.ts  pure RAM-fit heuristic + curated pull catalog (Models page)
    presets/                    built-in action prompts (Debug/Translate/…)
    notebook/                   MarkdownStore (truth) + SqliteNotebookIndex (FTS5) + reconcile
                                (+ folder-store.ts: folders.json org layer — folder tree + note→folder map, kept separate so notes stay flat Markdown)
    settings/                   API keys (encrypted) + default text/vision model picks
    ollama-process.service.ts   auto-start Ollama; detect install, link to ollama.com if absent
src/renderer/
  panel.tsx                     the notch HUD (incl. OCR "grab text" button)
  notebook.tsx                  notebook (folder tree, resizable sidebar, dark mode) + combined Settings/Models page
  settings-view.tsx             combined Settings + Models page (API keys, default picks, notch on/off toggle)
  models-view.tsx               Models page: RAM-fit badges, pull/delete, default picks
  preload-panel.ts / preload-notebook.ts   narrow contextBridge IPC surfaces
build-resources/ocr.swift       Vision-framework OCR helper, compiled by `npm run build:ocr`
```

## Conventions

- Markdown files in `userData/notebook/` are the source of truth; the SQLite index is rebuilt
  from disk on launch (`reconcile.ts`). Never treat the DB as authoritative over the files.
- Renderer security: `contextIsolation: true`, `nodeIntegration: false`. All main↔renderer
  traffic goes through the preload bridges — don't widen them without reason. Both windows are
  navigation-locked in `main.ts` (`hardenWindow`): no off-app navigation, and links/`window.open`
  are routed to the system browser via `shell.openExternal`.
- Model/clipboard-sourced output is untrusted. It reaches the screen only through XSS-safe
  paths: the streaming pane writes via `textContent`/`createTextNode`, and the notebook editor
  parses Markdown into the **ProseMirror schema** (`editor/extensions.ts`), which drops any tag
  or attribute without a registered node — so raw script/event-handler HTML can't become
  executable nodes. The Link mark runs with `openOnClick: false`. Never inject this content as
  raw HTML; if a raw-HTML path is ever unavoidable, run it through DOMPurify first.
- Capture/screenshot/tray shell out via `execFile` with fixed args (no shell) — keep it that way.

## Open work

See `TODOS.md` for deferred items (capture wiring, stream cancellation, cross-platform install,
streaming races). Check it before starting adjacent work.
