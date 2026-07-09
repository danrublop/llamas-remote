// App settings persisted to userData/settings.json.
//
// Holds cloud-provider API keys (OpenAI / Anthropic). Keys are encrypted at rest with
// Electron safeStorage (OS keychain-backed) and stored as `enc:<base64>`. In memory they
// are plaintext for use by the LLM clients. If encryption is unavailable (e.g. the keychain
// is locked), we NEVER write the key in plaintext — it is kept in memory for the current
// session only and omitted from disk (the user re-enters it next launch). Legacy plaintext
// keys from older builds are still read on load and re-encrypted on the next save.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { safeStorage } from 'electron';
import type { Preset } from '../presets/presets';
import { BUILT_IN_PRESETS } from '../presets/presets';
import { validateUserPreset } from '../presets/slash-commands';

export interface AppSettings {
  openaiKey?: string;
  anthropicKey?: string;
  /** User-chosen default model for text queries (overrides the built-in default). */
  defaultTextModel?: string;
  /** User-chosen default model for image/vision queries (overrides the built-in default). */
  defaultVisionModel?: string;
  /** User-defined slash commands (Exp-5). Stored plaintext (not secrets). */
  customPresets?: Preset[];
  /** Whether the notch panel + its global shortcut are active. Defaults to on. */
  notchEnabled?: boolean;
}

export class SettingsService {
  private settings: AppSettings = {};

  constructor(private readonly file: string) {
    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as AppSettings;
        this.settings = {
          openaiKey: decrypt(raw.openaiKey),
          anthropicKey: decrypt(raw.anthropicKey),
          defaultTextModel: raw.defaultTextModel,
          defaultVisionModel: raw.defaultVisionModel,
          customPresets: Array.isArray(raw.customPresets) ? raw.customPresets : [],
          notchEnabled: raw.notchEnabled,
        };
        // Migrate any legacy plaintext keys to encrypted at rest, once.
        const hasLegacyPlaintext = [raw.openaiKey, raw.anthropicKey].some((v) => v && !v.startsWith('enc:'));
        if (hasLegacyPlaintext) this.save();
      }
    } catch (e) {
      // A corrupt/truncated settings file would otherwise silently wipe the user's
      // encrypted API keys. Preserve the bad file for recovery and log loudly instead.
      this.settings = {};
      try {
        if (existsSync(file)) {
          const backup = `${file}.corrupt-${Date.now()}`;
          renameSync(file, backup);
          console.error(`Settings file was unreadable; backed up to ${backup}. Re-enter API keys in Settings.`, e);
        }
      } catch (e2) {
        console.error('Settings file unreadable and could not be backed up:', e2);
      }
    }
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  /** Returns a redacted view (keys -> boolean "set") plus default model picks for the renderer. */
  getRedacted(): { openaiKeySet: boolean; anthropicKeySet: boolean; defaultTextModel?: string; defaultVisionModel?: string; notchEnabled: boolean } {
    return {
      openaiKeySet: !!this.settings.openaiKey,
      anthropicKeySet: !!this.settings.anthropicKey,
      defaultTextModel: this.settings.defaultTextModel,
      defaultVisionModel: this.settings.defaultVisionModel,
      notchEnabled: this.isNotchEnabled(),
    };
  }

  /** Whether the notch is active (defaults to on when unset). */
  isNotchEnabled(): boolean {
    return this.settings.notchEnabled !== false;
  }

  setNotchEnabled(enabled: boolean): void {
    this.settings.notchEnabled = enabled;
    this.save();
  }

  setKey(provider: 'openai' | 'anthropic', key: string): void {
    const trimmed = key.trim();
    if (provider === 'openai') this.settings.openaiKey = trimmed || undefined;
    else this.settings.anthropicKey = trimmed || undefined;
    this.save();
  }

  /** Persist a default model pick. Empty string clears it (back to the built-in default). */
  setDefaultModel(kind: 'text' | 'vision', model: string): void {
    const trimmed = model.trim() || undefined;
    if (kind === 'text') this.settings.defaultTextModel = trimmed;
    else this.settings.defaultVisionModel = trimmed;
    this.save();
  }

  // ---- Custom slash commands (Exp-5) --------------------------------------------------

  /** The user's saved custom slash commands. */
  getCustomPresets(): Preset[] {
    return [...(this.settings.customPresets ?? [])];
  }

  /** Validate + add a custom command. Returns an error string on rejection (id collision,
   *  bad shape) and does NOT persist; on success it saves and returns ok. */
  addCustomPreset(input: Partial<Preset>): { ok: true } | { ok: false; error: string } {
    const existing = this.getCustomPresets();
    const ids = new Set<string>([...BUILT_IN_PRESETS.map((p) => p.id), ...existing.map((p) => p.id)]);
    const res = validateUserPreset(input, ids);
    if (!res.ok) return res;
    this.settings.customPresets = [...existing, res.preset];
    this.save();
    return { ok: true };
  }

  /** Remove a custom command by id (no-op if absent). */
  removeCustomPreset(id: string): void {
    this.settings.customPresets = this.getCustomPresets().filter((p) => p.id !== id);
    this.save();
  }

  private save(): void {
    try {
      if (!existsSync(dirname(this.file))) mkdirSync(dirname(this.file), { recursive: true });
      // Encrypt keys before writing; model picks + custom presets aren't secrets, plaintext.
      const onDisk: AppSettings = {
        openaiKey: encrypt(this.settings.openaiKey),
        anthropicKey: encrypt(this.settings.anthropicKey),
        defaultTextModel: this.settings.defaultTextModel,
        defaultVisionModel: this.settings.defaultVisionModel,
        customPresets: this.settings.customPresets ?? [],
        notchEnabled: this.settings.notchEnabled,
      };
      // Atomic write: a crash mid-write must not truncate the real file (which would
      // wipe the encrypted keys on next launch). Write a temp file then rename over.
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(onDisk, null, 2), 'utf8');
      renameSync(tmp, this.file);
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  }
}

/** Encrypt a key for disk. Returns ciphertext (`enc:…`), or undefined when there's no key
 *  OR encryption is unavailable — we never persist an API key in plaintext. When a key
 *  exists but can't be encrypted, it stays in memory for the session and is dropped from
 *  the file (a warning is logged), so a locked keychain can't leak keys to disk. */
function encrypt(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(value).toString('base64')}`;
  } catch { /* fall through to the unavailable path */ }
  console.warn(
    'safeStorage encryption is unavailable — API key kept in memory for this session only and ' +
      'NOT written to disk. Re-enter it next launch, or unlock the OS keychain.',
  );
  return undefined; // never plaintext at rest
}

function decrypt(value?: string): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    } catch {
      return undefined; // corrupt/unreadable — treat as unset
    }
  }
  return value; // legacy plaintext (re-encrypted on next save)
}

/** Default settings path under Electron userData. */
export function settingsPath(userDataDir: string): string {
  return join(userDataDir, 'settings.json');
}
