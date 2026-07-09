# Changelog

All notable changes to Llamas Remote are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
