import { app, BrowserWindow, globalShortcut, ipcMain, Tray, Menu, nativeImage, systemPreferences, shell, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { join, extname, basename } from 'path';
import { pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import { rmSync, existsSync, readFileSync, statSync } from 'fs';
import { OllamaProcessService } from './services/ollama-process.service';
// Notch panel stack (notch/notebook pivot)
import { createMacCaptureProvider, isAccessibilityTrusted } from './services/capture/mac-capture';
import type { CaptureProvider } from './services/capture/capture';
import { captureRegion } from './services/vision/screenshot';
import { resolveOcrBinary, recognizeText } from './services/vision/ocr';
import { fitFor, MODEL_CATALOG } from './services/models/model-capability';
import { isVisionCapable } from './services/router/model-router';
import { totalmem } from 'os';
import { NotchController } from './services/notch/notch-controller';
import { StreamSession } from './services/notch/stream-session';
import { InlineGenerationSession } from './services/notch/inline-gen-session';
import { OllamaLlmClient } from './services/llm/ollama-llm-client';
import { OpenAiLlmClient } from './services/llm/openai-llm-client';
import { AnthropicLlmClient } from './services/llm/anthropic-llm-client';
import { MultiLlmClient, CLOUD_MODELS } from './services/llm/multi-llm-client';
import { SettingsService, settingsPath } from './services/settings/settings-service';
import { MarkdownStore, isValidEntryId, makeEntry } from './services/notebook/markdown-store';
import { FolderStore } from './services/notebook/folder-store';
import { migrateHtmlBodies } from './services/notebook/migrate-html-bodies';
import { NotebookStore } from './services/notebook/notebook-store';
import { sanitizeIncomingBlocks } from './services/notebook/sidecar';
import { MemoryNotebookIndex } from './services/notebook/memory-index';
import type { NotebookIndex } from './services/notebook/types';
import { BUILT_IN_PRESETS } from './services/presets/presets';

const DEFAULT_TEXT_MODEL = 'mistral:latest';
const VISION_MODEL = 'llava:latest';

// ── Llamas Remote main process ───────────────────────────────────────────────
//
//   hotkey / tray ─▶ capture selection ─▶ show notch panel ─▶ panel runs query
//                                                                │
//                            NotchController ─▶ Ollama ─▶ stream tokens ─▶ panel
//                                    └─▶ NotebookStore (markdown + FTS5 index)
//
// The app lives in the menu bar (Tray) and the notch panel; there is no always-on
// toolbar window. Legacy auth/license/explanation UI was removed in the pivot.
class MainProcess {
  private notchPanel: BrowserWindow | null = null;
  private notchReady = false;
  private pendingCaptured: { selection: string; sourceApp?: string; empty: boolean; error?: string } | null = null;
  private pendingExpand = false;
  private accessibilityPrompted = false;
  private screenshotInFlight = false;
  private tray: Tray | null = null;
  // Allowlists of renderer-usable file paths. The renderer can't be trusted to send arbitrary
  // absolute paths (it would let a compromised renderer read e.g. ~/.ssh/id_rsa into a prompt,
  // or rm an arbitrary file): a path is only honored if the app itself produced it — attachments
  // chosen via the native picker, screenshots written by our own capture.
  private readonly allowedAttachmentPaths = new Set<string>();
  private readonly allowedImagePaths = new Set<string>();

  private ollamaProcessService = new OllamaProcessService();
  private notchController: NotchController | null = null;
  private streamSession: StreamSession | null = null;
  // Inline `/` generations stream into a specific AI block. Kept SEPARATE from streamSession
  // (the panel's single streaming pane) so a notebook generation and a panel query — or two
  // inline generations of different blocks — never abort each other.
  private inlineGen: InlineGenerationSession | null = null;
  private captureProvider: CaptureProvider | null = null;
  private notebookStore: NotebookStore | null = null;
  private folderStore: FolderStore | null = null;
  private llmClient: OllamaLlmClient | null = null;
  private settingsService: SettingsService | null = null;
  private notebookWindow: BrowserWindow | null = null;
  // Held by reference and handed to NotchController; mutated when the user changes their
  // default model on the Models page, so routing picks it up without rebuilding the controller.
  private routerConfig = { defaultTextModel: DEFAULT_TEXT_MODEL, visionModel: VISION_MODEL };

  async initialize(): Promise<void> {
    await app.whenReady();

    // Wire the notch panel stack (capture + controller + notebook).
    this.setupNotch();

    // Menu-bar presence + the notch panel (the primary UI). The notch can be switched off
    // in Settings — when off, no island and no global shortcut (the menu-bar tray remains).
    this.createTray();
    if (this.settingsService?.isNotchEnabled() ?? true) {
      this.createNotchPanel();
      if (this.notchPanel) this.notchPanel.showInactive(); // visible on first launch
      this.registerGlobalShortcuts();
    }
    this.setupNotchIpc();
    this.handleAppLifecycle();
    this.setupAutoUpdate();

    // Start Ollama automatically (auto-install/start handled by the service). Fire-and-forget
    // AFTER the UI exists — the model pull can take minutes, and awaiting it here left first
    // launch with no tray/notch until it finished.
    void this.startOllamaIfNeeded();

    // No dock icon — this is a menu-bar utility.
    if (process.platform === 'darwin') app.dock?.hide();

    console.log('Llamas Remote — initialized');
  }

  private setupNotch(): void {
    try {
      const userData = app.getPath('userData');
      const notebookDir = join(userData, 'notebook');

      // One-time HTML→Markdown body migration (backup-first, idempotent). Runs BEFORE the
      // index rebuild so reconcile re-indexes from migrated Markdown, not stale HTML.
      try {
        const res = migrateHtmlBodies(notebookDir);
        if (!res.alreadyDone) console.log(`notebook migration: ${res.migrated} migrated, ${res.skipped} skipped, ${res.failed} failed`);
      } catch (e) {
        console.warn('notebook HTML→Markdown migration failed:', e);
      }

      const files = new MarkdownStore(notebookDir);

      let index: NotebookIndex;
      try {
        // Lazy require: if better-sqlite3 isn't built for this Electron ABI, fall back to
        // an in-memory index so the app still launches (persistence just won't survive a restart).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { SqliteNotebookIndex } = require('./services/notebook/sqlite-index');
        index = new SqliteNotebookIndex(join(userData, 'notebook.db'));
      } catch (err) {
        console.warn('SQLite index unavailable; using in-memory index.', err);
        index = new MemoryNotebookIndex();
      }

      this.notebookStore = new NotebookStore(files, index);
      try {
        this.notebookStore.syncFromDisk();
      } catch (e) {
        console.warn('notebook syncFromDisk failed:', e);
      }

      // Folder manifest (organization only — lives beside the .md files, never over them).
      this.folderStore = new FolderStore(join(notebookDir, 'folders.json'), () => randomUUID());

      this.captureProvider = createMacCaptureProvider();
      this.llmClient = new OllamaLlmClient();
      this.settingsService = new SettingsService(settingsPath(userData));
      // Seed the router defaults from saved settings (fall back to the built-ins).
      const s0 = this.settingsService.get();
      this.routerConfig.defaultTextModel = s0.defaultTextModel || DEFAULT_TEXT_MODEL;
      this.routerConfig.visionModel = s0.defaultVisionModel || VISION_MODEL;
      const llm = new MultiLlmClient({
        ollama: this.llmClient,
        openai: new OpenAiLlmClient(() => this.settingsService?.get().openaiKey),
        anthropic: new AnthropicLlmClient(() => this.settingsService?.get().anthropicKey),
      });
      this.notchController = new NotchController({
        llm,
        notebook: this.notebookStore,
        routerConfig: this.routerConfig,
        presets: BUILT_IN_PRESETS,
        newId: () => randomUUID(),
        now: () => new Date().toISOString(),
      });
      // Owns streaming into the notebook window: buffers until the renderer is ready,
      // tags each run so a superseding query can't be overwritten by a stale stream, and
      // carries an AbortSignal so a superseded / window-closed run stops generating.
      this.streamSession = new StreamSession({
        send: (channel, payload) => this.sendNotebook(channel, payload),
        newId: () => randomUUID(),
      });
      // Inline AI-block generations, keyed per blockId (see InlineGenerationSession).
      this.inlineGen = new InlineGenerationSession({
        send: (channel, payload) => this.sendNotebook(channel, payload),
        newId: () => randomUUID(),
      });
    } catch (err) {
      console.error('Failed to set up notch stack:', err);
    }
  }

  // Lock down a window's navigation surface. The renderer displays model- and
  // clipboard-sourced content, so we never let it navigate away from the bundled app page
  // (which would hand an attacker-controlled origin the preload IPC bridge) and we route
  // any link/window.open to the user's real browser instead of opening it in-app.
  private hardenWindow(win: BrowserWindow): void {
    const wc = win.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    // The only file:// URLs we ever load are these two bundled pages (see createNotchPanel /
    // createNotebookWindow). Allowing the bare file:// scheme would let injected/app code load
    // ANY local file with the preload bridge attached — so pin the allow to these exact hrefs.
    const allowedPages = new Set(
      ['panel.html', 'notebook.html'].map((f) => pathToFileURL(join(__dirname, '..', f)).href),
    );
    const guard = (e: Electron.Event, url: string): void => {
      // Allow only in-app navigation/reload of our own bundled pages (ignore hash/query);
      // externalize web links, block everything else.
      if (allowedPages.has(url.split(/[?#]/)[0])) return;
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
  }

  // Dynamic-Island style: a transparent canvas pinned to the top-center, the same width
  // as the menu bar around the notch. The renderer draws a black island fused to the
  // notch (square top, round bottom) that expands on hover/hotkey. The window stays
  // click-through (forwarding move events so :hover works) until the pointer is over the
  // island or the panel is expanded — so it never blocks the screen underneath.
  private createNotchPanel(): void {
    if (this.notchPanel && !this.notchPanel.isDestroyed()) return;
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const width = Math.min(820, display.workAreaSize.width);
    const height = 540;
    const x = Math.round((display.bounds.width - width) / 2); // centered on the physical display

    this.notchReady = false;
    this.notchPanel = new BrowserWindow({
      width,
      height,
      x,
      y: 0, // flush with the very top so the island fuses with the notch
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      show: false,
      skipTaskbar: true,
      fullscreenable: false,
      // Defeats AppKit's "constrain frame to visible screen" clamp, so a y:0 window can
      // sit OVER the menu bar (otherwise it's parked at the work-area top, below the bar).
      enableLargerThanScreen: true,
      // Float above full-screen apps and the menu bar.
      type: process.platform === 'darwin' ? 'panel' : undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: join(__dirname, 'preload-panel.js'),
      },
    });
    this.hardenWindow(this.notchPanel);
    this.notchPanel.setAlwaysOnTop(true, 'screen-saver');
    if (process.platform === 'darwin') {
      this.notchPanel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    this.notchPanel.loadFile(join(__dirname, '..', 'panel.html')).catch((e) => console.error('Failed to load panel:', e));

    this.notchPanel.webContents.on('did-finish-load', () => {
      this.notchReady = true;
      // Force the window to the ABSOLUTE display top (over the menu-bar level), not the
      // work-area top — otherwise macOS parks it below the menu bar and the island floats.
      if (this.notchPanel && !this.notchPanel.isDestroyed()) {
        const d = require('electron').screen.getPrimaryDisplay();
        const w = Math.min(820, d.bounds.width);
        // Force the window to the ABSOLUTE display top (over the menu bar), not the
        // work-area top — else macOS parks it below the menu bar and the island floats.
        this.notchPanel.setAlwaysOnTop(true, 'screen-saver');
        this.notchPanel.setBounds({ x: Math.round((d.bounds.width - w) / 2), y: d.bounds.y, width: w, height: 540 });
      }
      if (!this.notchPanel || this.notchPanel.isDestroyed()) return;
      // Flush a capture/expand requested via the hotkey before the window finished loading.
      if (this.pendingCaptured) {
        this.notchPanel.webContents.send('panel:captured', this.pendingCaptured);
        this.pendingCaptured = null;
      }
      if (this.pendingExpand) {
        this.notchPanel.webContents.send('panel:expand');
        this.notchPanel.setIgnoreMouseEvents(false);
        this.pendingExpand = false;
      } else {
        // Idle: click-through, but forward move events so the renderer can detect hover.
        this.notchPanel.setIgnoreMouseEvents(true, { forward: true });
      }
    });

    // On blur, collapse back to the island and go click-through (unless mid-screenshot).
    this.notchPanel.on('blur', () => {
      if (this.screenshotInFlight) return;
      if (this.notchPanel && !this.notchPanel.isDestroyed()) {
        this.notchPanel.webContents.send('panel:collapse');
        this.notchPanel.setIgnoreMouseEvents(true, { forward: true });
      }
    });
    this.notchPanel.on('closed', () => {
      this.notchPanel = null;
      this.notchReady = false;
    });
  }

  // When capture is blocked, trigger the real macOS Accessibility prompt (adds the app to
  // the list) and open the Accessibility settings pane. Fires at most once per session.
  private promptAccessibility(): void {
    if (this.accessibilityPrompted || process.platform !== 'darwin') return;
    this.accessibilityPrompted = true;
    try {
      // prompting=true surfaces the system "grant Accessibility" dialog for this app.
      systemPreferences.isTrustedAccessibilityClient(true);
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    } catch (e) {
      console.warn('Failed to prompt for Accessibility:', e);
    }
  }

  private async handleNotchHotkey(): Promise<void> {
    if (!(this.settingsService?.isNotchEnabled() ?? true)) return; // notch switched off
    this.createNotchPanel();
    const panel = this.notchPanel;
    if (!panel) return;

    // First explicit use without Accessibility granted: surface the permission prompt up
    // front rather than after a confusing empty capture (the native AX read returns null
    // silently when untrusted).
    if (process.platform === 'darwin' && !isAccessibilityTrusted()) this.promptAccessibility();

    // Capture the current selection BEFORE showing our panel (focus is still on the
    // source app). On-demand only — never monitored in the background. This is an explicit
    // action, so the synthetic-Cmd+C clipboard fallback is allowed.
    let captured: { selection: string; sourceApp?: string; empty: boolean; error?: string } =
      { selection: '', sourceApp: undefined, empty: true };
    try {
      if (this.captureProvider) {
        const res = await this.captureProvider.captureSelection({ allowClipboardFallback: true });
        captured = { selection: res.text, sourceApp: res.sourceApp, empty: res.text.trim().length === 0 };
      }
    } catch (e) {
      console.warn('Selection capture failed:', e);
      captured = { selection: '', sourceApp: undefined, empty: true, error: e instanceof Error ? e.message : 'capture failed' };
      this.promptAccessibility();
    }

    if (this.notchReady && !panel.isDestroyed()) {
      panel.webContents.send('panel:captured', captured);
      panel.webContents.send('panel:expand');
      panel.setIgnoreMouseEvents(false); // interactive so the expanded panel takes input
    } else {
      // Window still loading — flush both on did-finish-load (and become interactive then).
      this.pendingCaptured = captured;
      this.pendingExpand = true;
    }

    panel.show();
    panel.focus();
  }

  // Resolve a bundled asset both in dev (build-resources/) and packaged (extraResources
  // copies it to Contents/Resources/).
  private assetPath(name: string): string {
    return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'build-resources', name);
  }

  private createTray(): void {
    try {
      // Menu-bar template image (the gamepad-directional symbol). Template = monochrome
      // black+alpha; macOS recolors it for the light/dark menu bar. The @2x sibling is
      // auto-loaded for Retina.
      const iconPath = this.assetPath('trayTemplate.png');
      const image = nativeImage.createFromPath(iconPath);
      if (!image.isEmpty()) image.setTemplateImage(true);
      this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
      this.tray.setToolTip('Llamas Remote');
      const menu = Menu.buildFromTemplate([
        { label: 'Ask  (⌘⇧Space)', click: () => this.handleNotchHotkey() },
        { label: 'Notebook', click: () => this.showNotebook() },
        { label: 'Settings…', click: () => this.showSettings() },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => this.checkForUpdatesManually() },
        { type: 'separator' },
        { label: 'Quit Llamas Remote', click: () => app.quit() },
      ]);
      this.tray.setContextMenu(menu);
      this.tray.on('click', () => this.toggleNotch());
    } catch (err) {
      console.warn('Failed to create tray:', err);
    }
  }

  private toggleNotch(): void {
    // The island always hangs from the notch; tray/activate just pops it open.
    this.handleNotchHotkey();
  }

  // ── Auto-update ────────────────────────────────────────────────────────────────────────
  // Whether a downloaded update is staged and waiting for the next quit to install.
  private updateReady = false;
  // Set while a user-initiated "Check for Updates…" is in flight, so the (otherwise silent)
  // update events surface a dialog only for the manual path — the launch check stays quiet.
  private manualCheck = false;

  // Wire electron-updater: check the GitHub release feed on launch, download in the
  // background, and install on quit. NOTE: on macOS this only works for a SIGNED + notarized
  // build (electron-updater verifies the signature); an unsigned build silently no-ops. See
  // RELEASING.md for the signing/publish setup.
  private setupAutoUpdate(): void {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (err: Error) => {
      console.warn('[auto-update] error:', err?.message ?? err);
      if (this.manualCheck) { this.manualCheck = false; this.updateDialog('warning', 'Could not check for updates.', String(err?.message ?? err)); }
    });
    autoUpdater.on('update-not-available', () => {
      if (this.manualCheck) { this.manualCheck = false; this.updateDialog('info', "You're up to date.", `Llamas Remote ${app.getVersion()} is the latest version.`); }
    });
    autoUpdater.on('update-available', () => {
      if (this.manualCheck) { this.manualCheck = false; this.updateDialog('info', 'Downloading update…', 'It will install the next time you quit Llamas Remote.'); }
    });
    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      this.updateReady = true;
      this.tray?.setToolTip(`Llamas Remote — update ${info.version} ready (restart to install)`);
    });
    // Dev builds have no update feed (and no app-update.yml); only check when packaged.
    if (app.isPackaged) {
      autoUpdater.checkForUpdatesAndNotify().catch((e) => console.warn('[auto-update] initial check failed:', e?.message ?? e));
    }
  }

  private checkForUpdatesManually(): void {
    if (!app.isPackaged) {
      this.updateDialog('info', 'Updates unavailable in development', 'Run the installed app to receive updates.');
      return;
    }
    if (this.updateReady) {
      dialog
        .showMessageBox({ type: 'info', message: 'Update ready', detail: 'Restart Llamas Remote to install the downloaded update.', buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1 })
        .then(({ response }) => { if (response === 0) setImmediate(() => autoUpdater.quitAndInstall()); })
        .catch(() => {});
      return;
    }
    this.manualCheck = true;
    autoUpdater.checkForUpdates().catch((e) => {
      this.manualCheck = false;
      this.updateDialog('warning', 'Could not check for updates.', String(e?.message ?? e));
    });
  }

  private updateDialog(type: 'info' | 'warning', message: string, detail: string): void {
    dialog.showMessageBox({ type, message, detail, buttons: ['OK'] }).catch(() => {});
  }

  // The notebook is the content window: a normal resizable window where answers stream in.
  private createNotebookWindow(): void {
    if (this.notebookWindow && !this.notebookWindow.isDestroyed()) return;
    this.notebookWindow = new BrowserWindow({
      width: 900,
      height: 720,
      minWidth: 600,
      show: false,
      title: 'Llamas Remote — Notebook',
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: join(__dirname, 'preload-notebook.js'),
      },
    });
    this.hardenWindow(this.notebookWindow);
    // Hide the native traffic lights — the renderer draws its own (glossy, always-visible)
    // window controls in the sidebar/top bar, wired via the win:* IPC below.
    if (process.platform === 'darwin') this.notebookWindow.setWindowButtonVisibility(false);
    // A fresh load means the renderer hasn't mounted its listeners yet — buffer events
    // until it signals 'notebook:ready' (handshake), and re-buffer on any reload.
    this.streamSession?.markNotReady();
    this.notebookWindow.webContents.on('did-start-loading', () => {
      // A reload tears down the renderer's editor (and any AI block mid-generation) — stop
      // in-flight inline runs so they don't stream into a block that no longer exists.
      this.inlineGen?.abortAll();
      this.streamSession?.markNotReady();
    });
    this.notebookWindow.loadFile(join(__dirname, '..', 'notebook.html')).catch((e) => console.error('Failed to load notebook:', e));
    this.notebookWindow.on('closed', () => {
      this.notebookWindow = null;
      // No window to stream into — stop any in-flight generation and re-buffer.
      this.streamSession?.abortActive();
      this.inlineGen?.abortAll();
      this.streamSession?.markNotReady();
    });
  }

  private showNotebook(): void {
    this.createNotebookWindow();
    if (this.notebookWindow && !this.notebookWindow.isDestroyed()) {
      if (process.platform === 'darwin') app.dock?.show();
      this.notebookWindow.show();
      this.notebookWindow.focus();
      // Melt the notch back to its resting nub explicitly — don't rely on the panel's
      // blur firing (unreliable for an alwaysOnTop type:'panel' window). Fires on the
      // explicit "open notebook" action AND on auto-open-when-done.
      if (this.notchPanel && !this.notchPanel.isDestroyed()) {
        this.notchPanel.webContents.send('panel:collapse');
        this.notchPanel.setIgnoreMouseEvents(true, { forward: true });
      }
    }
  }

  private sendNotebook(channel: string, payload?: unknown): void {
    if (this.notebookWindow && !this.notebookWindow.isDestroyed()) {
      this.notebookWindow.webContents.send(channel, payload);
    }
  }

  // Read attached files to text for the prompt. Caps per-file size (256 KB) and total
  // (768 KB) so a stray binary or huge log can't blow the context window; unreadable or
  // over-cap files are skipped (the model still gets the rest of the query).
  private readAttachments(paths?: string[]): Array<{ name: string; content: string }> {
    if (!paths?.length) return [];
    const PER_FILE = 256 * 1024;
    const TOTAL = 768 * 1024;
    const out: Array<{ name: string; content: string }> = [];
    let used = 0;
    for (const p of paths.slice(0, 10)) {
      try {
        // Only read paths the user actually chose via the native picker — never an arbitrary
        // absolute path the renderer made up (which could exfiltrate ~/.ssh/id_rsa et al.).
        if (!this.allowedAttachmentPaths.has(p)) continue;
        if (!existsSync(p) || statSync(p).size > PER_FILE) continue;
        const content = readFileSync(p, 'utf8');
        if (used + content.length > TOTAL) break;
        used += content.length;
        out.push({ name: basename(p), content });
      } catch { /* skip unreadable / non-text files */ }
    }
    return out;
  }

  // Settings lives in the notebook's right pane (single, unified surface). Open/focus the
  // notebook window and tell it to switch to the settings view — waiting for first load if
  // the window was just created so the renderer is listening when the message arrives.
  private showSettings(): void {
    const fresh = !this.notebookWindow || this.notebookWindow.isDestroyed();
    this.showNotebook();
    const win = this.notebookWindow;
    if (!win) return;
    if (fresh) win.webContents.once('did-finish-load', () => win.webContents.send('notebook:show-settings'));
    else win.webContents.send('notebook:show-settings');
  }

  private setupNotchIpc(): void {
    ipcMain.handle('panel:run-query', async (_event, req: {
      kind: 'text' | 'image';
      presetId?: string;
      freeText?: string;
      selection?: string;
      sourceApp?: string;
      imagePath?: string;
      userSelectedModel?: string;
      attachments?: string[]; // absolute paths the user attached via the picker
      autoOpen?: boolean; // open the notebook automatically when done (default true)
    }) => {
      if (!this.notchController || !this.streamSession) return { ok: false, error: 'Notch controller not ready' };
      const session = this.streamSession;

      const attachments = this.readAttachments(req.attachments);
      // Only honor an image path our own capture produced — never an arbitrary path the
      // renderer supplies (which would let it have any file base64'd to a cloud LLM, or
      // deleted in the cleanup below).
      const imagePath = req.imagePath && this.allowedImagePaths.has(req.imagePath) ? req.imagePath : undefined;

      // The answer streams into the notebook window (created hidden if not open). The panel
      // only shows progress + an Open button. beginRun aborts any prior in-flight query and
      // gives us a run id (so its late tokens can't overwrite this one) + an abort signal.
      this.createNotebookWindow();
      const { runId, signal } = session.beginRun();
      const preset = req.presetId ? BUILT_IN_PRESETS.find((p) => p.id === req.presetId) : undefined;
      const label = preset?.name ?? (req.freeText?.trim() || 'Ask');
      const displayModel = req.userSelectedModel || (req.kind === 'image' ? this.routerConfig.visionModel : this.routerConfig.defaultTextModel);
      session.emit(runId, 'notebook:start', { prompt: label, selection: req.selection ?? '', sourceApp: req.sourceApp, model: displayModel });

      try {
        const result = await this.notchController.runQuery({
          kind: req.kind,
          presetId: req.presetId,
          freeText: req.freeText,
          userSelectedModel: req.userSelectedModel,
          capture:
            req.kind === 'text'
              ? { text: req.selection ?? '', sourceApp: req.sourceApp, via: 'clipboard' }
              : undefined,
          imagePath,
          attachments,
          signal,
          onToken: (delta) => session.emit(runId, 'notebook:token', delta),
        });
        session.emit(runId, 'notebook:done', result.answer);
        if (result.entry) session.emit(runId, 'notebook:saved', result.entry.id);
        if (req.autoOpen !== false) this.showNotebook(); // auto-open when done
        return { ok: true, answer: result.answer, model: result.model, entryId: result.entry?.id };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        // A cancelled run was superseded/closed deliberately — don't flash an error.
        // Match the explicit 'cancelled' marker AND any stream-level cancel that landed
        // after the signal aborted (axios surfaces those as "...stream error: canceled").
        const wasCancelled = message === 'cancelled' || signal.aborted || /cancell?ed/i.test(message);
        if (!wasCancelled) {
          session.emit(runId, 'notebook:error', message);
          if (req.autoOpen !== false) this.showNotebook();
        }
        return { ok: false, error: message };
      } finally {
        session.endRun(runId);
        // Clean up the temp screenshot once the model has consumed it (only our own path).
        if (req.kind === 'image' && imagePath && existsSync(imagePath)) {
          try { rmSync(imagePath); } catch { /* ignore */ }
          this.allowedImagePaths.delete(imagePath);
        }
      }
    });

    // Let the panel attach files: open a native picker and hand back the chosen paths +
    // display names (the panel can't touch the filesystem). Contents are read at run time.
    ipcMain.handle('panel:pick-files', async () => {
      const win = this.notchPanel ?? undefined;
      const result = win
        ? await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })
        : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] });
      if (result.canceled) return [];
      // Remember exactly which paths the user approved via the picker; only these may be
      // read back at run time (see readAttachments).
      result.filePaths.forEach((p) => this.allowedAttachmentPaths.add(p));
      return result.filePaths.map((p) => ({ path: p, name: basename(p) }));
    });

    // On-demand capture when the panel opens (hover/click), while the source app is still
    // frontmost. The panel becomes mouse-interactive without taking key focus, so a
    // synthetic Cmd+C still targets the app the user was in.
    ipcMain.handle('panel:capture', async () => {
      if (!this.captureProvider) return { selection: '', sourceApp: undefined, empty: true };
      try {
        // Hover-open is passive: do the native AX read only, never inject a synthetic Cmd+C
        // just because the panel opened. The hotkey path (handleNotchHotkey) allows the
        // clipboard fallback because it's an explicit user action.
        const r = await this.captureProvider.captureSelection({ allowClipboardFallback: false });
        return { selection: r.text, sourceApp: r.sourceApp, empty: r.text.trim().length === 0 };
      } catch (e) {
        console.warn('panel:capture failed:', e);
        this.promptAccessibility();
        return { selection: '', sourceApp: undefined, empty: true, error: e instanceof Error ? e.message : 'capture failed' };
      }
    });

    // The panel's saved default models (so its picker reflects the Models-page choice).
    ipcMain.handle('panel:defaults', () => {
      const s = this.settingsService?.get() ?? {};
      return { text: s.defaultTextModel, vision: s.defaultVisionModel };
    });

    // Renderer handshake: the notebook view has mounted and attached its notebook:* listeners.
    // Flush anything buffered while it was loading (fixes the first-answer-invisible drop).
    ipcMain.on('notebook:ready', () => this.streamSession?.markReady());

    // Inline generation from the notebook itself: a `/` command (or freeform prompt) runs
    // against a model and streams INTO a specific AI block in the open note. Distinct from
    // panel:run-query — it does NOT create a new note (persist:false) and uses notebook:gen-*
    // channels tagged with the target blockId so the renderer streams into the right block.
    ipcMain.handle('notebook:generate', async (_event, req: {
      blockId: string;
      commandId?: string;        // built-in slash-command (preset) id
      freeText?: string;         // custom prompt / typed follow-up
      selection?: string;        // text the command operates on (may be empty for pure generate)
      userSelectedModel?: string;
    }) => {
      if (!this.notchController || !this.inlineGen) return { ok: false, error: 'Notebook generation not ready' };
      if (!isValidEntryId(req.blockId)) return { ok: false, error: 'Invalid block id' };
      const gen = this.inlineGen;
      const { blockId } = req;
      // Per-block run: aborts only this block's own prior run (re-run), never the panel query
      // or another block's generation.
      const { runId, signal } = gen.begin(blockId);
      const displayModel = req.userSelectedModel || DEFAULT_TEXT_MODEL;
      gen.emit(blockId, runId, 'notebook:gen-start', { blockId, model: displayModel });
      try {
        const result = await this.notchController.runQuery({
          kind: 'text',
          presetId: req.commandId, // built-in presets; custom user commands resolve once persisted in settings
          freeText: req.freeText,
          userSelectedModel: req.userSelectedModel,
          capture: { text: req.selection ?? '', via: 'clipboard' },
          persist: false, // the answer lives in a block inside the current note, not a new entry
          signal,
          onToken: (delta) => gen.emit(blockId, runId, 'notebook:gen-token', { blockId, delta }),
        });
        gen.emit(blockId, runId, 'notebook:gen-done', { blockId, answer: result.answer, model: result.model });
        return { ok: true, model: result.model, answer: result.answer };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        // Suppress the error only when the run was deliberately cancelled (superseded/closed).
        // Match the same signals the panel path does — an exact 'cancelled', an aborted
        // signal, or a provider stream-level "...canceled". emit() itself also drops the
        // event if this run was superseded, so a re-run's fresh block is never marked errored.
        const wasCancelled = message === 'cancelled' || signal.aborted || /cancell?ed/i.test(message);
        if (!wasCancelled) gen.emit(blockId, runId, 'notebook:gen-error', { blockId, message });
        return { ok: false, error: message };
      } finally {
        gen.end(blockId, runId);
      }
    });

    // Open the notebook window immediately (the panel's Open button) to watch streaming.
    ipcMain.on('open-notebook', () => this.showNotebook());

    // Model picker = local Ollama models + cloud models for providers whose key is set.
    ipcMain.handle('panel:models', async () => {
      const local = this.llmClient ? await this.llmClient.listModels() : [];
      const s = this.settingsService?.get() ?? {};
      const cloud = [
        ...(s.openaiKey ? CLOUD_MODELS.openai : []),
        ...(s.anthropicKey ? CLOUD_MODELS.anthropic : []),
      ];
      return [...local, ...cloud];
    });

    // Settings window + operations.
    ipcMain.on('open-settings', () => this.showSettings());
    ipcMain.handle('settings:get', () => this.settingsService?.getRedacted() ?? { openaiKeySet: false, anthropicKeySet: false, notchEnabled: true });
    ipcMain.handle('settings:set-notch', (_e, enabled: boolean) => { this.applyNotchEnabled(!!enabled); });
    ipcMain.handle('settings:set-key', (_e, provider: 'openai' | 'anthropic', key: string) => {
      this.settingsService?.setKey(provider, key);
    });
    ipcMain.handle('ollama:pull', async (event, name: string) => {
      if (!this.llmClient || !name.trim()) return { ok: false, error: 'No model name' };
      try {
        await this.llmClient.pullModel(name.trim(), (status, percent) => {
          if (!event.sender.isDestroyed()) event.sender.send('settings:pull-progress', { name, status, percent });
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Pull failed' };
      }
    });

    // Notebook (notes app) operations. Every handler that takes an `id` validates it at the
    // boundary: the id becomes a filename downstream, so a renderer-supplied `../` or
    // absolute path must be rejected before it can read/delete files outside the notebook dir.
    ipcMain.handle('notebook:list', () => this.notebookStore?.list() ?? []);
    // Cancel any in-flight inline generation (called on editor unmount so a run doesn't keep
    // streaming into a block whose editor is gone).
    ipcMain.handle('notebook:cancel-gen', () => { this.inlineGen?.abortAll(); });
    // Re-read notes from disk and hand back the fresh summaries (called on window focus so
    // external edits show up). Guarded — a sync failure returns whatever we have.
    ipcMain.handle('notebook:resync', () => {
      try {
        this.notebookStore?.syncFromDisk();
        return this.notebookStore?.list() ?? [];
      } catch {
        return [];
      }
    });
    ipcMain.handle('notebook:search', (_e, query: string) => this.notebookStore?.search(query) ?? []);
    ipcMain.handle('notebook:get', (_e, id: string) => (isValidEntryId(id) ? this.notebookStore?.getBody(id) ?? null : null));
    // Body + AI-block sidecar in one round trip, so the editor can reconstruct AI blocks on
    // load (anchors alone don't survive the markdown parse — see reconstruct.ts).
    ipcMain.handle('notebook:get-note', (_e, id: string) => {
      if (!isValidEntryId(id) || !this.notebookStore) return null;
      const body = this.notebookStore.getBody(id);
      if (body === null) return null;
      return { body, aiBlocks: this.notebookStore.getAiBlocks(id) };
    });
    ipcMain.handle('notebook:image', (_e, id: string) => {
      if (!isValidEntryId(id)) return null;
      const p = this.notebookStore?.getImagePath(id);
      if (!p || !existsSync(p)) return null;
      try {
        const ext = extname(p).slice(1).toLowerCase() || 'png';
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        return `data:image/${mime};base64,${readFileSync(p).toString('base64')}`;
      } catch {
        return null;
      }
    });
    ipcMain.handle('notebook:rename', (_e, id: string, title: string) => { if (isValidEntryId(id)) this.notebookStore?.rename(id, title); });
    ipcMain.handle('notebook:pin', (_e, id: string, pinned: boolean) => { if (isValidEntryId(id)) this.notebookStore?.setPinned(id, pinned); });
    ipcMain.handle('notebook:update-body', (_e, id: string, body: string, aiBlocks?: unknown) => {
      if (!isValidEntryId(id)) return;
      // Only touch the sidecar when the renderer actually sent blocks. Undefined = body-only
      // save (leave the sidecar alone); an array (even empty) = rewrite it (empty deletes it).
      const blocks = aiBlocks === undefined ? undefined : sanitizeIncomingBlocks(aiBlocks);
      this.notebookStore?.updateBody(id, body, blocks);
    });
    ipcMain.handle('notebook:hide', (_e, id: string) => { if (isValidEntryId(id)) this.notebookStore?.hide(id); });
    ipcMain.handle('notebook:restore', (_e, id: string) => { if (isValidEntryId(id)) this.notebookStore?.restore(id); });
    ipcMain.handle('notebook:delete', (_e, id: string) => {
      if (!isValidEntryId(id)) return;
      this.notebookStore?.delete(id);
      this.folderStore?.forgetNote(id);
    });

    // Create an empty note from the notebook UI (New note), optionally inside a folder.
    ipcMain.handle('notebook:create', (_e, folderId?: string) => {
      if (!this.notebookStore) return null;
      const id = randomUUID();
      this.notebookStore.save(makeEntry({ id, body: '', tags: [], model: '', sourceApp: '' }));
      if (folderId) this.folderStore?.moveNote(id, folderId);
      return id;
    });

    // ── Folder manifest (tree + note→folder assignments) ──────────────────────────────
    ipcMain.handle('folders:get', () => this.folderStore?.getState() ?? { folders: [], assignments: {} });
    ipcMain.handle('folders:create', (_e, name: string, parentId: string | null) => {
      try { return this.folderStore?.createFolder(name, parentId ?? null) ?? null; }
      catch { return null; }
    });
    ipcMain.handle('folders:rename', (_e, id: string, name: string) => {
      try { this.folderStore?.renameFolder(id, name); } catch { /* ignore */ }
    });
    ipcMain.handle('folders:delete', (_e, id: string) => {
      try { this.folderStore?.deleteFolder(id); } catch { /* ignore */ }
    });
    ipcMain.handle('folders:move-note', (_e, noteId: string, folderId: string | null) => {
      try { if (isValidEntryId(noteId)) this.folderStore?.moveNote(noteId, folderId ?? null); } catch { /* ignore */ }
    });
    ipcMain.handle('folders:move-folder', (_e, id: string, parentId: string | null) => {
      try { this.folderStore?.moveFolder(id, parentId ?? null); } catch { /* ignore */ }
    });

    // ── Custom window controls (native traffic lights are hidden) ─────────────────────
    ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
    ipcMain.on('win:zoom', (e) => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (!w) return;
      w.isMaximized() ? w.unmaximize() : w.maximize();
    });
    ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

    ipcMain.handle('panel:screenshot', async () => {
      if (this.screenshotInFlight) return null; // a capture is already up — don't overlap crosshairs
      this.screenshotInFlight = true;
      try {
        const { path } = await captureRegion();
        // Mark our own capture as a legitimate image path the renderer may pass to run-query.
        if (path) this.allowedImagePaths.add(path);
        return path;
      } catch (e) {
        console.error('Screenshot failed:', e);
        return null;
      } finally {
        this.screenshotInFlight = false;
        if (this.notchPanel && !this.notchPanel.isDestroyed()) {
          this.notchPanel.show();
          this.notchPanel.focus();
        }
      }
    });

    // Grab text from a screen region with NO model: screencapture -i, then on-device
    // Vision OCR. Sidesteps vision-model RAM cost entirely. Returns recognized text.
    ipcMain.handle('panel:ocr', async () => {
      if (this.screenshotInFlight) return { text: '', cancelled: true }; // capture already in flight
      this.screenshotInFlight = true;
      let shot: string | null = null;
      try {
        const { path } = await captureRegion();
        shot = path;
        if (!shot) return { text: '', cancelled: true };
        const bin = resolveOcrBinary({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() });
        const text = await recognizeText(bin, shot);
        return { text };
      } catch (e) {
        console.error('OCR failed:', e);
        return { text: '', error: e instanceof Error ? e.message : 'OCR failed' };
      } finally {
        this.screenshotInFlight = false;
        if (shot && existsSync(shot)) { try { rmSync(shot); } catch { /* ignore */ } }
        if (this.notchPanel && !this.notchPanel.isDestroyed()) { this.notchPanel.show(); this.notchPanel.focus(); }
      }
    });

    // Models page: installed models with size + RAM-fit badge + vision flag, plus cloud
    // models when a key is set. "fit" is a capacity estimate (see model-capability.ts).
    ipcMain.handle('models:list-detailed', async () => {
      const totalRam = totalmem();
      const installed = this.llmClient ? await this.llmClient.listModelsDetailed() : [];
      const local = installed.map((m) => {
        const vision = isVisionCapable(m.name);
        return {
          id: m.name,
          provider: 'ollama' as const,
          sizeBytes: m.sizeBytes,
          vision,
          installed: true,
          fit: fitFor({ modelBytes: m.sizeBytes, totalRamBytes: totalRam, isVision: vision }),
        };
      });
      const s = this.settingsService?.get() ?? {};
      const cloud = [
        ...(s.openaiKey ? CLOUD_MODELS.openai : []),
        ...(s.anthropicKey ? CLOUD_MODELS.anthropic : []),
      ].map((id) => ({ id, provider: 'cloud' as const, sizeBytes: 0, vision: isVisionCapable(id), installed: true, fit: 'cloud' as const }));
      const defaults = this.settingsService?.getRedacted() ?? { defaultTextModel: undefined, defaultVisionModel: undefined };
      return {
        totalRamBytes: totalRam,
        models: [...local, ...cloud],
        defaultTextModel: defaults.defaultTextModel ?? this.routerConfig.defaultTextModel,
        defaultVisionModel: defaults.defaultVisionModel ?? this.routerConfig.visionModel,
      };
    });

    // Curated recommendations to pull, each with a RAM-fit badge and whether it's installed.
    ipcMain.handle('models:catalog', async () => {
      const totalRam = totalmem();
      const installedNames = new Set(this.llmClient ? (await this.llmClient.listModels()) : []);
      // Ollama lists a bare `moondream` pull as `moondream:latest`, so a catalog id
      // without a tag must also match its `:latest` form — otherwise an installed model
      // keeps showing "Install".
      const isInstalled = (id: string) => installedNames.has(id) || (!id.includes(':') && installedNames.has(`${id}:latest`));
      return MODEL_CATALOG.map((m) => ({
        ...m,
        installed: isInstalled(m.id),
        fit: fitFor({ modelBytes: m.sizeBytes, totalRamBytes: totalRam, isVision: m.vision }),
      }));
    });

    ipcMain.handle('models:delete', async (_e, name: string) => {
      if (!this.llmClient || !name) return { ok: false, error: 'No model' };
      try {
        await this.llmClient.deleteModel(name);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Delete failed' };
      }
    });

    ipcMain.handle('models:set-default', (_e, kind: 'text' | 'vision', model: string) => {
      this.settingsService?.setDefaultModel(kind, model);
      // Mutate the live router config so the next query routes to the new pick.
      if (kind === 'text') this.routerConfig.defaultTextModel = model.trim() || DEFAULT_TEXT_MODEL;
      else this.routerConfig.visionModel = model.trim() || VISION_MODEL;
    });

    ipcMain.handle('panel:search', (_event, query: string) => {
      if (!this.notebookStore) return [];
      try {
        return this.notebookStore.search(query);
      } catch {
        return [];
      }
    });

    // Renderer toggles interactivity as the pointer enters/leaves the island, so the
    // transparent canvas stays click-through everywhere else.
    ipcMain.on('panel:set-interactive', (_event, interactive: boolean) => {
      if (this.notchPanel && !this.notchPanel.isDestroyed()) {
        this.notchPanel.setIgnoreMouseEvents(!interactive, { forward: true });
      }
    });

    // Collapse back to the idle island (does not hide — the island always hangs from the notch).
    ipcMain.on('panel:close', () => {
      if (this.notchPanel && !this.notchPanel.isDestroyed()) {
        this.notchPanel.webContents.send('panel:collapse');
        this.notchPanel.setIgnoreMouseEvents(true, { forward: true });
      }
    });

    // Focus-on-engage: a hover-opened panel is interactive but never key, so Esc/blur
    // can't fire. When it runs an action it asks for focus so keyboard dismiss works.
    ipcMain.on('panel:focus', () => {
      if (this.notchPanel && !this.notchPanel.isDestroyed()) this.notchPanel.focus();
    });
  }

  private readonly notchShortcut = process.platform === 'darwin' ? 'Cmd+Shift+Space' : 'Ctrl+Shift+Space';

  private registerGlobalShortcuts(): void {
    if (!globalShortcut.isRegistered(this.notchShortcut)) {
      globalShortcut.register(this.notchShortcut, () => this.handleNotchHotkey());
    }
    console.log(`Global shortcut registered: ${this.notchShortcut}`);
  }

  /** Turn the notch (island + global shortcut) on or off and persist the choice. */
  private applyNotchEnabled(enabled: boolean): void {
    this.settingsService?.setNotchEnabled(enabled);
    if (enabled) {
      this.createNotchPanel();
      this.notchPanel?.showInactive();
      this.registerGlobalShortcuts();
    } else {
      globalShortcut.unregister(this.notchShortcut);
      if (this.notchPanel && !this.notchPanel.isDestroyed()) this.notchPanel.destroy();
      this.notchPanel = null;
    }
  }

  private handleAppLifecycle(): void {
    // Menu-bar app: keep running when the panel is hidden/closed.
    app.on('window-all-closed', () => {
      // no-op on macOS; the tray keeps the app alive
      if (process.platform !== 'darwin') app.quit();
    });
    app.on('activate', () => this.toggleNotch());
    app.on('before-quit', () => {
      this.ollamaProcessService.stopOllama();
    });
  }

  private async startOllamaIfNeeded(): Promise<void> {
    try {
      const isRunning = await this.ollamaProcessService.checkIfRunning();
      if (isRunning) {
        console.log('Ollama is already running');
        return;
      }
      console.log('Starting Ollama...');
      const started = await this.ollamaProcessService.startOllama();
      if (started) {
        await this.ollamaProcessService.ensureModelAvailable(DEFAULT_TEXT_MODEL);
      } else {
        console.warn('Failed to start Ollama automatically; user can start it manually.');
      }
    } catch (error) {
      console.error('Error during Ollama startup:', error);
    }
  }
}

const mainProcess = new MainProcess();
mainProcess.initialize().catch((error) => {
  console.error('Failed to initialize main process:', error);
  app.quit();
});
