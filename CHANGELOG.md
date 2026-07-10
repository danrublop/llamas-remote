# Changelog

All notable changes to Llamas Remote are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.10.0] - 2026-07-10

### Added
- **Section flags.** Every heading gets a sparkle in its left gutter — click (or two-finger-click) it to colour that section. The colour also dots the section in the sidebar outline. Flags persist per note.
- **Find in note (⌘F).** With a note open, ⌘F opens an in-note find bar that highlights every match and marks the current one; Enter / ⇧Enter step through them, Esc closes. (⌘F with no note open still opens cross-note search.)

### Fixed
- Sidebar section labels no longer show raw Markdown (`**Javadoc**` → Javadoc) and dropped the stray native hover tooltip.

## [1.9.0] - 2026-07-10

### Added
- **Section titles + sidebar outline.** A heading button in the editor toolbar turns the selected block into a section title. The open note's sections drop down beneath it in the sidebar note tree (chevron to collapse) — click one to jump straight to it. Sections are plain Markdown headings, so they round-trip through the `.md` file.

## [1.8.1] - 2026-07-10

### Added
- **Drawing documents.** A palette button — left of New note, and in the Create / folder-right-click menus — makes a drawing its own first-class item alongside notes and chats (`source_kind: drawing`, palette icon in the note list and search). Opening one drops a full Excalidraw canvas straight into the main content area (the way a chat opens the chat view) and **autosaves as you draw** — no Cancel/Done. The scene lives in the note's sidecar, a flattened PNG in `images/draw-<id>.png`, and the note body keeps the viewable `![drawing](…)` anchor so the raw `.md` still shows the picture. Drawings can still be embedded inside a regular note via the editor toolbar's palette button.

### Changed
- Chat view polish: a per-response copy button, a model-picker dropdown, and an empty-state glyph.
- Chats now **title themselves from the first message** instead of staying "Untitled".
- **⌘+ / ⌘- / ⌘0 zoom** the notebook window (there's no app menu to carry the built-in zoom roles).
- The tray icon's left-click now opens its menu instead of toggling the notch (the click was stealing focus and instantly dismissing the menu); summon the notch from the menu's "Ask" item.
- The notch panel gets rounded bottom corners with concave "shoulder" fillets where it meets the top of the screen.

### Fixed
- **Font/size/color pickers now behave like a real editor.** Changing the font, size, text color, or highlight applies only to the selected text — or, with no selection, sets a pending style that the next typed text picks up (instead of silently re-styling every note). Selecting text now shows that text's actual font, size, and colors in the toolbar.
- **macOS auto-update builds.** The universal build no longer aborts on the shared `ocr` helper (`x64ArchFiles`), so signed DMG/ZIP artifacts and the `latest-mac.yml` update feed actually publish.

## [1.7.0] - 2026-07-10

### Added
- **Drawings in notes (Excalidraw).** A pencil button in the editor toolbar inserts a drawing and opens a centered, theme-aware Excalidraw canvas — pen, shapes, arrows, text, colors, eraser, select. Double-click a drawing to reopen and keep editing. Each note's Markdown holds a viewable `![drawing](images/draw-<id>.png)` plus an invisible `<!--draw:id-->` anchor; the re-editable scene JSON lives in an `<id>.draw.json` sidecar (same truth model as AI blocks). Excalidraw is lazy-loaded into its own webpack chunk so the base notebook bundle stays lean.
- **Table right-click menu.** Right-click (or two-finger-tap on a trackpad) inside a table opens a Google-Docs-style menu: insert/delete column, insert/delete row, toggle header row, merge/split cells, delete table — all wired to stock TipTap commands.

### Changed
- **Notifications moved to the top-right as frosted-glass banners** (macOS-style), theme-aware, with swipe-right-to-dismiss (mouse drag or trackpad two-finger horizontal swipe).
- **Right-click note/folder menus size to their content** instead of a fixed width, so short actions (Pin / Delete) no longer leave dead space on the right.

## [1.6.1] - 2026-07-09

### Fixed
- **Number-like tags no longer disappear.** A note whose tags were all bare literals (e.g. `2024`, `42`, `true`) lost them on the next save/reload: the tag was written unquoted as `[2024]`, then decoded as a number and dropped. Such tags are now quoted on write, and existing notes that already lost the quoting are recovered on read. Regression tests added.

## [1.6.0] - 2026-07-09

### Added
- **Tables in notes.** A table button in the editor toolbar opens a Google-Docs-style grid picker — drag across the grid to size, click to insert. Columns are resizable, and tables round-trip through the on-disk Markdown as GFM pipe tables (verified so they survive save/reload).
- **Code language on the block.** The syntax-highlighting language for a code block now lives as a dropdown on the block itself (top-right, on hover) instead of the toolbar, so each block picks its own language.
- **Note tags.** Notes carry tags in their Markdown frontmatter (source of truth), indexed for search, shown as chips with tag filtering.
- **Notch as a clipboard.** The selection box in the notch has a copy button (bottom-right on hover) that copies the captured text to the system clipboard; the scrollbar is hidden for a cleaner read.
- **Empty-note placeholder** in the editor ("Start writing, or type / for AI…"), which also advertises the `/` slash command.

### Changed
- **`/` commands run on the note's text.** A slash command with nothing selected now operates on the note text above the command instead of sending an empty selection (which made the model riff on the command word). Highlighted text still takes priority.
- Anthropic answers use a per-model `max_tokens` ceiling with an honest "(truncated)" marker instead of silently capping at 4096.
- Faster dev builds and a non-blocking Ollama startup (the tray/notch no longer wait on the model pull).

### Fixed
- **Inline `/` generation no longer loses its answer on a note switch.** Switching notes mid-generation now cancels the run cleanly instead of discarding the finished answer and writing it to the wrong note.
- Pins survive an index rebuild; a malformed or unreadable note file no longer vanishes a note or aborts the whole disk reconcile; note search no longer crashes on a stray quote.
- Accessibility permission is now surfaced (once) when hovering the notch with no permission granted, instead of a silently blank capture box.
- Hardening: Content-Security-Policy on both windows, navigation locked to the app's own pages, and guarded folder IPC handlers.

## [1.5.0] - 2026-07-09

### Added
- **In-app auto-update.** The app now checks GitHub for new releases on launch, downloads them in the background, and installs the update on the next quit — with a "Check for Updates…" item in the tray menu for an on-demand check. Update checks only run in packaged builds.
- **Signed & notarized publishing pipeline.** Releases are built, signed, and notarized through a reproducible `npm run release:mac` flow and published to GitHub. The signing/notarization step is a no-op when Apple credentials aren't present, so unsigned local builds still work. See `RELEASING.md` for the release flow and required secrets.

### Changed
- Removed stale pre-pivot release scripts and artifacts (old "i cant code" build/homebrew tooling) and fixed lingering references to the previous project name in the remaining release script.

## [1.4.2] - 2026-07-09

### Fixed
- **AI blocks now survive reopening a note.** A `/`-command answer used to collapse into plain text the moment you switched notes or relaunched — losing its model label and the re-run button. Blocks are now stored alongside the note and rebuilt when it loads, so they stay AI blocks.
- **Re-run works after a reload.** The command and the text a block ran on are saved with it, so re-running a block from an earlier session repeats the original request instead of a blank one.
- **Running two things at once no longer cancels one of them.** A `/` command in a note and a notch capture (or a second `/` command in another block) used to abort each other and leave a block stuck spinning forever. Each generation is now independent, and a block always finishes or shows an error.
- Text color, highlight, and code blocks are preserved when a note with AI blocks is reopened (they could previously be dropped on reload). Links in notes no longer open on a single click in the editor.

## [1.4.1] - 2026-07-09

### Fixed
- **Editing one note can no longer bleed into another.** Switching notes within a fraction of a second of typing used to let the pending save land in the newly-opened note (corrupting it and losing the edit). Each note's edits are now saved to that note, no matter how fast you switch.
- **Your last keystrokes are no longer dropped** when you switch notes, open Settings, or trigger a screen capture right after typing — the pending edit is flushed instead of discarded.
- **Note files are now written atomically.** A crash, power loss, or full disk mid-save can no longer leave a half-written, unreadable note behind.
- **Your folder layout is protected too.** The folder file is written atomically, and if it ever becomes unreadable it's backed up (not silently thrown away), so a bad write can't erase all your folders and note-to-folder assignments without a trace.

## [1.4.0] - 2026-07-09

### Added
- **Notebook redesign** with a warm editorial look and a **dark mode** — toggle it with the sun/moon button in the top bar; your choice is remembered between launches.
- **Folders in the sidebar.** Organize notes into nestable folders, drag notes between them, and drag folders into other folders. Two-finger click (or right-click) empty space to make a new note or folder; two-finger click a note or folder for its actions (rename, delete, pin), and the menu opens right where you clicked.
- **Resizable sidebar.** Drag the divider on its right edge to set the width you like; it sticks.
- **Rich text in notes:** set text color, highlight passages, and drop in **syntax-highlighted code blocks** for Java, Python, JavaScript, and more — all of which survive save/reload.
- **Turn the notch on or off** from Settings, without quitting the app.
- **Inline AI in the notebook is now switched on** — type `/` in a note to run a command and stream the answer straight into your text.

### Changed
- **Settings and Models are now one page**, reached from the sidebar footer.
- The notch panel dismisses more predictably (Escape, click-away, and losing focus all behave consistently).

### Fixed
- Highlight and text-color survive the Markdown round-trip, and colors from imported/AI text are sanitized so notes stay safe to open anywhere.
- A hand-edited or corrupt folder layout no longer hangs the app on launch.
- Creating a folder inside a collapsed folder now reveals it for renaming instead of silently naming it "New Folder".

## [1.3.0] - 2026-05-26

### Changed
- Notebook notes now store their body as **Markdown** instead of HTML, so the files in your notebook folder stay clean and open correctly in any Markdown editor. Existing notes are converted automatically on first launch, and the original of every converted note is kept in a `.pre-md-backup` folder just in case.

### Added
- Groundwork for inline AI in the notebook (a block editor, a `/` command catalog including your own custom commands, and a notebook-to-model streaming path). Not switched on in the editor yet — it lands in a follow-up release.

## [1.2.0] - 2026-05-26

### Added
- **Models page** in the notebook: see every model (installed + cloud), whether it fits your Mac's RAM (comfortable / tight / won't fit), pull recommended models, delete local ones, and set your default text and vision model.
- **Grab text from a screenshot** — a new notch button that pulls the text out of any screen region on-device (no model, no RAM cost) and drops it in as your selection.
- Screenshots can now use a cloud vision model (gpt-4o, Claude) when you've added an API key, not just local llava.

### Fixed
- Selection capture now reads the real selection via the macOS accessibility API (so it works in apps that ignore a synthetic copy), only falls back to Cmd+C on an explicit action, and never loses an image/file already on your clipboard.
- The first answer after launch now streams in instead of appearing to hang and popping in late.
- Starting a new question or closing the notebook now stops the previous answer instead of letting stale text bleed in.
- A vision model that runs out of memory now shows a clear message (free RAM / try a smaller model / use cloud) instead of a cryptic error.
- Cloud (OpenAI/Anthropic) errors now show the provider's real message instead of "Request failed with status code 400".
- Long answers no longer stutter while streaming.
- Your saved API keys survive a crash during a settings save.

### Changed
- Dropped the unsafe automatic Ollama installer; the app now detects Ollama and links you to ollama.com if it's missing.

## [1.1.1] - 2026-05-26

### Removed
- Deleted ~23 stale docs from the pre-pivot "Code Explainer" / "i cant code" eras and stray release/extract scripts.
- Removed two unused services (`ollama.service.ts`, `code-analysis.service.ts`, 646 LOC) that the notch/notebook pivot left stranded.
- Dropped unused dependencies: `electron-log`, `getos`, `@types/getos`.

### Changed
- Rewrote `README.md` to describe the current notch/notebook app instead of the old Mistral popup.
- Added `CLAUDE.md` with build/test commands, the pivot history, and an architecture map.

### Added
- Round-trip tests for the notebook's on-disk Markdown format (`markdown-store`).
- Tests for API-key persistence (`settings-service`): encrypt-at-rest, legacy-plaintext migration, and the silent-drop-on-corruption path.

### Tests
- Suite grew from 50 to 67 passing tests.
