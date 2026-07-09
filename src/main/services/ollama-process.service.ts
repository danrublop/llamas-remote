import { spawn, ChildProcess } from 'child_process';
import { platform } from 'os';
import { existsSync } from 'fs';
import { shell } from 'electron';
import axios from 'axios';
import { OllamaLlmClient } from './llm/ollama-llm-client';

// Known macOS Ollama binary locations: Homebrew (Intel + Apple Silicon) and the
// Ollama.app bundle (what ollama.com's macOS download installs).
const MAC_OLLAMA_PATHS = [
  '/usr/local/bin/ollama',
  '/opt/homebrew/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama',
];
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';

export interface OllamaProcessStatus {
  isRunning: boolean;
  isStarting: boolean;
  error?: string;
  process?: ChildProcess;
}

export class OllamaProcessService {
  private readonly baseUrl = 'http://127.0.0.1:11434';
  private ollamaProcess: ChildProcess | null = null;
  private status: OllamaProcessStatus = {
    isRunning: false,
    isStarting: false
  };
  private startupPromise: Promise<boolean> | null = null;

  constructor() {
    // Check if Ollama is already running on startup
    this.checkIfRunning();
  }

  async checkIfRunning(): Promise<boolean> {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 3000 });
      this.status.isRunning = response.status === 200;
      this.status.isStarting = false;
      this.status.error = undefined;
      return this.status.isRunning;
    } catch (error) {
      this.status.isRunning = false;
      return false;
    }
  }

  async startOllama(): Promise<boolean> {
    // If already running, return true
    if (this.status.isRunning) {
      return true;
    }

    // If startup is in progress, wait for it
    if (this.startupPromise) {
      return this.startupPromise;
    }

    // Start the startup process
    this.startupPromise = this.performStartup();
    return this.startupPromise;
  }

  private async performStartup(): Promise<boolean> {
    try {
      this.status.isStarting = true;
      this.status.error = undefined;

      console.log('Starting Ollama...');

      // Determine the command based on platform
      const command = this.getOllamaCommand();

      // We don't auto-install: piping a network script into a root shell from a signed,
      // hardened-runtime app is a supply-chain risk, and the macOS download is an .app/dmg
      // (not the Linux install.sh). If it's missing, point the user at the official download.
      if (!this.isOllamaInstalled()) {
        console.warn('Ollama is not installed. Opening the download page.');
        try { await shell.openExternal(OLLAMA_DOWNLOAD_URL); } catch { /* best effort */ }
        throw new Error(`Ollama isn't installed. Get it at ${OLLAMA_DOWNLOAD_URL}, then reopen the app.`);
      }

      // Spawn the Ollama process
      this.ollamaProcess = spawn(command, ['serve'], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Handle process events
      this.setupProcessHandlers();

      // Wait for Ollama to be ready (with timeout)
      const isReady = await this.waitForOllamaReady(30000); // 30 second timeout

      if (isReady) {
        this.status.isRunning = true;
        this.status.isStarting = false;
        console.log('Ollama started successfully');
        return true;
      } else {
        throw new Error('Ollama failed to start within timeout period');
      }

    } catch (error) {
      this.status.isStarting = false;
      this.status.error = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to start Ollama:', this.status.error);
      return false;
    } finally {
      this.startupPromise = null;
    }
  }

  // Resolve the ollama binary path. macOS app is the only packaged target; on other
  // platforms we fall back to whatever is on PATH.
  private getOllamaCommand(): string {
    if (platform() === 'darwin') {
      return MAC_OLLAMA_PATHS.find((p) => existsSync(p)) ?? 'ollama';
    }
    return 'ollama'; // PATH fallback (dev on other platforms)
  }

  private isOllamaInstalled(): boolean {
    if (platform() === 'darwin') {
      return MAC_OLLAMA_PATHS.some((p) => existsSync(p));
    }
    // Non-macOS (dev only): trust PATH; checkIfRunning() is the real readiness gate.
    return true;
  }

  private setupProcessHandlers(): void {
    if (!this.ollamaProcess) return;

    this.ollamaProcess.stdout?.on('data', (data) => {
      console.log(`Ollama stdout: ${data}`);
    });

    this.ollamaProcess.stderr?.on('data', (data) => {
      console.error(`Ollama stderr: ${data}`);
    });

    this.ollamaProcess.on('error', (error) => {
      console.error('Ollama process error:', error);
      this.status.isRunning = false;
      this.status.isStarting = false;
      this.status.error = error.message;
    });

    this.ollamaProcess.on('exit', (code, signal) => {
      console.log(`Ollama process exited with code ${code} and signal ${signal}`);
      this.status.isRunning = false;
      this.status.isStarting = false;
      this.ollamaProcess = null;
    });
  }

  private async waitForOllamaReady(timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 1000; // Check every second

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 2000 });
        if (response.status === 200) {
          return true;
        }
      } catch (error) {
        // Ollama not ready yet, continue waiting
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    return false;
  }

  getStatus(): OllamaProcessStatus {
    return { ...this.status };
  }

  async stopOllama(): Promise<void> {
    if (this.ollamaProcess) {
      console.log('Stopping Ollama process...');
      this.ollamaProcess.kill('SIGTERM');

      // Wait a bit for graceful shutdown
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Force kill if still running
      if (this.ollamaProcess && !this.ollamaProcess.killed) {
        this.ollamaProcess.kill('SIGKILL');
      }

      this.ollamaProcess = null;
    }

    this.status.isRunning = false;
    this.status.isStarting = false;
  }

  async ensureModelAvailable(modelName: string = 'mistral:latest'): Promise<boolean> {
    try {
      // Check if model is already available
      const response = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 5000 });
      const models = response.data.models || [];
      const modelExists = models.some((model: any) => model.name === modelName);

      if (modelExists) {
        console.log(`Model ${modelName} is already available`);
        return true;
      }

      // Pull the model if not available. Delegate to OllamaLlmClient.pullModel, which streams
      // the NDJSON and rejects on a terminal {"error":...} line. The old fire-and-forget POST
      // ignored the body, so it logged "pulled successfully" even when the pull failed (the
      // error arrives over HTTP 200, so the POST itself resolves).
      console.log(`Pulling model ${modelName}...`);
      await new OllamaLlmClient().pullModel(modelName);

      console.log(`Model ${modelName} pulled successfully`);
      return true;

    } catch (error) {
      console.error(`Failed to ensure model ${modelName} is available:`, error);
      return false;
    }
  }
}
