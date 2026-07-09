# Llamas Remote

Query selected text and screenshots with local (or cloud) LLMs straight from the macOS
notch. A private capture → ask → notebook loop: highlight anything in any app, ask a
question, and the answer streams into a searchable notebook that lives on your machine.

## What it does

- **Notch panel** — a Dynamic-Island-style HUD fused to the macOS notch. Hover or hit the
  hotkey (`Cmd+Shift+Space`) to expand it; pick a one-tap action (Debug, Translate, Rephrase,
  Summarize) or type your own question.
- **On-demand capture** — reads your current selection only when you ask (never monitored in
  the background). Falls back to a synthetic `Cmd+C` that always restores your clipboard.
- **Screenshots** — drag-select a screen region and ask a vision model about it.
- **Attachments** — attach files to a query; their text is folded into the prompt (size-capped).
- **Local + cloud models** — local models via [Ollama](https://ollama.com), plus OpenAI and
  Anthropic when you add an API key. Keys are encrypted at rest with Electron `safeStorage`.
- **Notebook** — every answer is saved as a Markdown file (the source of truth) and indexed
  in SQLite FTS5 for full-text search. Organize notes into nestable folders; edit with rich
  text (colors, highlights, syntax-highlighted code blocks); pin, rename, delete (with undo),
  and export. Toggle a warm **dark mode** from the top bar.

## Architecture

```
hotkey / tray / hover ─▶ capture selection ─▶ notch panel ─▶ run query
                                                                │
   NotchController ─▶ MultiLlmClient ─▶ Ollama / OpenAI / Anthropic ─▶ stream tokens
            └─▶ NotebookStore ─▶ Markdown files (truth) + SQLite FTS5 index
```

- **Main process** (`src/main`) — Electron, TypeScript. Window/tray/IPC glue in `main.ts`;
  all logic in injectable services under `src/main/services` (capture, llm, notch, notebook,
  router, presets, settings, vision).
- **Renderer** (`src/renderer`) — React + TypeScript. `panel.tsx` (notch HUD) and
  `notebook.tsx` (notebook + in-pane settings). IPC is exposed through narrow preload bridges
  (`preload-panel.ts`, `preload-notebook.ts`) with `contextIsolation` on, `nodeIntegration` off.
- **Persistence** — Markdown files in `userData/notebook/`, indexed by `notebook.db`
  (better-sqlite3). The index is rebuilt from disk on launch (`reconcile.ts`), so the files
  are authoritative and survive an index wipe.

## Prerequisites

- **Node.js** 20+
- **Ollama** for local models. The app tries to start a running Ollama on launch; install it
  from [ollama.com](https://ollama.com) if auto-start fails.
- A local model pulled (e.g. `ollama pull llama3.2`), and/or an OpenAI/Anthropic API key added
  in Settings.

> Platform note: capture, screenshots, and tray are macOS-first (they shell out to `osascript`
> and `screencapture`). Windows/Linux builds exist but the capture path is not yet wired there.

## Develop

```bash
npm install
npm run dev        # build main + watch renderer + launch electron
npm test           # vitest (unit tests for the service layer)
npm run test:watch
```

## Build

```bash
npm run build      # compile main + renderer
npm run dist:mac   # package a universal macOS dmg/zip via electron-builder
```

See `DEVELOPMENT.md` for the hot-reload workflow and `DESIGN.md` for the design system.

## License

MIT
