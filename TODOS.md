# TODOS

Deferred work from the 2026-05-25 CEO review of the local-LLM notch/notebook pivot.
See the full plan: `~/.gstack/projects/danrublop-Code-Explainer/ceo-plans/2026-05-25-local-llm-notch-notebook.md`

## P2 — Local RAG over folders / notebook
- **What:** Index the user's own documents and the saved notebook for retrieval-augmented local answers.
- **Why:** The natural next differentiator after the capture→ask→persist loop; turns the notebook from storage into a queryable knowledge base. GPT4All proves the demand.
- **Context:** Notebook already stores markdown + a SQLite FTS5 index (v1). RAG adds a local embedding model (via Ollama) + vector store. Start by embedding existing notebook entries.
- **Effort:** L (human) → M (CC). **Depends on:** v1 notebook persistence shipped.

## P2 — Full task-based model auto-routing
- **What:** Pick the local model by task type (code / general / long-context), beyond v1's vision-autodetect + manual pick.
- **Why:** Hides model complexity = the "easily use local LLMs" promise. Was scoped down in v1 (first-to-cut) to avoid ambiguity.
- **Context:** Needs a defined routing decision table: inputs = source app, language (from code-analysis.service), selection length, preset. Was deferred because the heuristic was under-specified at plan time.
- **Effort:** M (human) → S (CC). **Depends on:** v1 manual picker + presets shipped.

## P3 — Opt-in auto-popup on selection (continuous monitoring)
- **What:** Optional mode where the app watches selections and shows a Look-Up-style affordance the moment you highlight text.
- **Why:** Better discovery UX than remembering a hotkey. Deferred from eng review E4.
- **Context:** selection-hook supports a continuous monitoring mode. Kept OFF in v1 for battery + privacy (the "we never read anything until you ask" story). Ship as explicit opt-in toggle if users ask.
- **Effort:** S (human) → S (CC). **Depends on:** v1 CaptureProvider shipped.

## P2/P3 — Re-runnable notebook cells
- **What:** Make each saved answer an editable cell you can re-run against a model, Jupyter-style.
- **Why:** Pushes toward the 12-month "living notebook" vision where chat IS the notebook.
- **Context:** v1 entries are immutable saved answers with a `conversation_id`. This adds edit + re-execute + cell ordering UX. Larger UX surface; sequence after core loop is loved.
- **Effort:** L (human) → M (CC). **Depends on:** v1 notebook + full app window shipped.

---

## From the 2026-05-26 Notebook AI Upgrade eng review

### P2 — sqlite-vec ABI spike before Phase 3 RAG
- **What:** Time-boxed spike to confirm whether `sqlite-vec` loads under the packaged Electron
  ABI + hardened runtime + notarization in the signed mac build. If not, commit to pure-JS cosine.
- **Why:** Phase 3 RAG's vector-store choice rests on an unvalidated assumption; native extensions
  are a known pain point in signed/notarized Electron apps, and finding out at impl time is costly.
- **Context:** App already ships `better-sqlite3` via `asarUnpack` + Electron-ABI rebuild;
  sqlite-vec is a second native surface. Pure-JS cosine over a chunks table is the safe default.
- **Depends on:** nothing. **Blocks:** Phase 3 vector-store design. **Effort:** S/S.

### P3 — first-time RAG embedding backfill UX
- **What:** First RAG enable embeds the existing notebook (O(N) Ollama calls); needs a background
  job + progress UI, not a blocking call.
- **Why:** A large notebook could take minutes; a blocking call looks frozen.
- **Context:** Re-embed-on-edit is planned; this is the one-time backfill. **Effort:** S/S.

---

## From the 2026-05-26 eng review (deferred from a cleanup pass)

Cleanup + dead-code removal landed; these correctness/robustness items were triaged out and
captured here so they aren't lost. Roughly priority-ordered.

> **2026-05-26 follow-up eng review + implementation:** the notch/capture deep-dive
> landed fixes for the items struck through below. Remaining open items are at the bottom.

### ✅ DONE — Cross-platform Ollama start/install (was P1)
Dropped the `curl … install.sh | sh` `sudo-prompt` auto-install (supply-chain risk + wrong
installer for macOS). `ollama-process.service.ts` now detects the Ollama.app / Homebrew
binary and opens `ollama.com/download` when absent. Dead `ollama.exe` branch removed;
`sudo-prompt` dependency removed. Scoped to macOS (the only packaged target).

### ✅ DONE — First-query streaming is invisible (was P1)
Replaced the fire-immediately sends with a `StreamSession` readiness queue: the notebook
renderer emits `notebook:ready` on mount and main buffers `notebook:*` events until then,
flushing on ready (and re-buffering on reload). Unit-tested in `stream-session.test.ts`.

### ✅ DONE — No cancellation for in-flight LLM streams (was P2)
`LlmClient.generate` now takes an `AbortSignal`, threaded to axios in all three clients;
`StreamSession.beginRun()` aborts the prior run, and closing the notebook window aborts the
active run. Cancels surface as a benign `'cancelled'` (no error flash). Note: collapsing the
*panel* does NOT cancel — the answer streams into the separate notebook window.

### ✅ DONE — Concurrent queries race into one notebook window (was P2)
`StreamSession` tags each run with an id and drops events from superseded runs (both queued
and live), so query B can't be overwritten by query A's late tokens. Unit-tested.

### ✅ DONE — Capture honesty: accessibility path is a stub (was P2)
`selection-hook` (N-API, macOS AXAPI) is now a real dependency wired into
`readAccessibilitySelection()` (lazy-loaded with a clipboard fallback if the native module
won't load). The clipboard fallback now snapshots/restores ALL formats (text/HTML/RTF/image),
and hover does a passive AX read only — the synthetic Cmd+C runs solely on explicit actions.

### ✅ DONE — Cloud vision is silently dropped (was P3)
`model-router.ts` is now capability-aware (`isVisionCapable`): a user-picked vision model
(gpt-4o, claude, llava) handles images; local llava is only forced when the pick can't see.
`imagePath` is threaded through the OpenAI + Anthropic clients as image content blocks.

### ✅ DONE — Surface cloud API error bodies (was P3)
Extracted `stream-error.ts` (`readStreamErrorMessage`) shared by all three clients, so
OpenAI/Anthropic now surface the provider's real message instead of "status code 400".

### P3 — Markdown serializer isn't comma/quote-safe for tags
- **What:** `markdown-store.ts` parses the `tags: [a, b]` flow list by splitting on `,` before unescaping, so a tag containing a comma doesn't round-trip. `esc()` only quotes on `:#\n`. (Covered as a known limitation in `markdown-store.test.ts`.)
- **Why:** Low real risk today (tags are app name + language), but it's silent corruption of the source-of-truth files if a comma ever lands in a tag.
- **How to start:** Quote-aware split, or store tags as JSON. Add the comma round-trip case to the test once fixed.
- **Effort:** S (human) → S (CC).

### P3 — Unprompted model download on launch
- **What:** `main.ts` `startOllamaIfNeeded()` calls `ensureModelAvailable('mistral:latest')`, pulling ~4GB on first run with no UI or consent. `DEFAULT_TEXT_MODEL` is also a leftover from the pre-pivot app.
- **Why:** Surprise multi-GB download; `mistral` may not be the model the user wants as default.
- **How to start:** Make the default model a setting; pull on first use with a progress UI (the pull-progress IPC already exists) instead of silently on launch.
- **Effort:** S (human) → S (CC).

### P3 — Wire structured logging
- **What:** `electron-log` was removed in the cleanup pass (it was an unused dependency); `src/main` has ~45 raw `console.*` calls that produce no output in a packaged build.
- **Why:** No diagnostics from shipped apps when users hit capture/Ollama errors.
- **How to start:** Re-add a logger (electron-log or similar) and route main-process logs to a file; keep console in dev.
- **Effort:** S (human) → S (CC).

---

## From the 2026-05-27 notch dismiss/reload eng review

### P3 — Notch visibility state machine (deferred Approach B)
- **What:** Refactor `panel.tsx` dismiss/visibility into one explicit state machine
  (`resting → expanding → expanded → dismissing → resting`) with a single `dismiss()`/`present()`
  pair, instead of the current fan-in of separate handlers (Esc, window-blur, click-nub,
  main-blur via IPC, mouse-leave) all calling `collapseNow()`.
- **Why:** The 2026-05-27 dismiss fix (Approach A) keeps handlers separate, which is fine for
  today's ~4 states. More states (pinned-while-streaming, multi-step capture) would make the
  spread-out handlers fragile and easy to add a trigger that forgets a cleanup step.
- **Context:** Approach A was chosen for the smallest explicit diff; B was explicitly deferred.
  See design doc `daniellopez-fix-audit-critical-high-design-20260527-120241.md` (Approaches
  Considered). Revisit when a 5th+ panel state appears.
- **Depends on:** nothing. **Effort:** M (human) → S/M (CC).

---

## From the 2026-07-09 notebook-redesign eng review (deferred, non-blocking)

### P3 — Smoother sidebar resize (avoid setState per mousemove)
- **What:** During a sidebar-divider drag, `notebook.tsx` calls `setSidebarWidth` on every
  `mousemove`, re-rendering the whole `Notebook` tree and reflowing the TipTap doc each frame.
- **Why:** Fine today; can jank on very large notes. Write the width to the DOM via a ref
  during drag and commit to React state only on `mouseup` (widthRef already holds the value).
- **Depends on:** nothing. **Effort:** S (human) → S (CC).

### P3 — Trim the lowlight bundle to offered languages
- **What:** `NotebookEditor.tsx` uses `createLowlight(common)` (~37 highlight.js grammars) but
  the code-block dropdown (`CODE_LANGS`) only exposes 19, shipping ~18 dead grammars in the
  renderer bundle.
- **Why:** Bundle size. Register just the offered grammars explicitly. Verify each language's
  import name before swapping — a wrong name silently drops highlighting (why it was deferred
  out of the ship rather than done blind).
- **Depends on:** nothing. **Effort:** S (human) → S (CC).
