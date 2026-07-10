// Markdown file store: the source of truth for entry bodies.
//
// Each entry is one `<id>.md` file with a small YAML frontmatter block followed by the
// answer body. We own both the writer and reader, so we use a minimal frontmatter
// (de)serializer for our known fields rather than pulling in a YAML dependency. Tags are
// a flow list (`tags: [a, b]`); everything else is a scalar.
//
//   ---
//   id: 01J...
//   created_at: 2026-05-25T17:00:00Z
//   model: llama3.2
//   source_app: Safari
//   source_kind: text
//   tags: [code, safari]
//   ---
//   <markdown body>

import { readdirSync, readFileSync, writeFileSync, renameSync, statSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'fs';
import { join, extname } from 'path';
import type { DiskEntry } from './reconcile';
import type { NotebookEntry, SourceKind } from './types';
import { readSidecar, writeSidecar, type AIBlockMeta } from './sidecar';
import { readDrawingSidecar, writeDrawingSidecar, type DrawingMeta } from './drawing-sidecar';

function esc(value: string): string {
  // Quote scalars that could confuse the minimal parser.
  return /[:#\n]/.test(value) ? JSON.stringify(value) : value;
}

/**
 * Serialize the tag list. Tags are user-editable, so a tag containing a comma, a bracket,
 * a quote, a newline, or leading/trailing whitespace would corrupt the bare comma-joined
 * flow list on round-trip (the reader splits on `,` and strips `[`/`]` before unescaping).
 * A tag that *looks like* a bare JSON literal (`2024`, `true`, `null`) is just as dangerous:
 * written bare as `[2024]` the reader would JSON-decode it to a number/boolean and drop it.
 * When any tag needs escaping we emit the whole array as strict JSON (`tags: ["2024","c"]`),
 * which parseEntry decodes atomically; otherwise we keep the readable bare form for the
 * common case (and for backward-compatible files written before this fix).
 */
function jsonNonString(t: string): boolean {
  // True when `t` would JSON-parse to a non-string (number/bool/null/array/object),
  // e.g. "2024" -> 2024, "true" -> true. Such a tag must be quoted in the JSON form.
  try { return typeof JSON.parse(t) !== 'string'; } catch { return false; }
}
function serializeTags(tags: readonly string[]): string {
  const needsJson = tags.some((t) => /[,[\]"\n]/.test(t) || t.trim() !== t || jsonNonString(t));
  if (needsJson) return JSON.stringify(tags);
  return `[${tags.map(esc).join(', ')}]`;
}

function unesc(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * Entry ids are server-generated (randomUUID). Reject anything else before it reaches the
 * filesystem so a renderer-supplied id (`notebook:delete`, `notebook:get`, …) can never
 * escape the notebook dir via `../` traversal or absolute paths. UUIDs only use
 * `[0-9a-f-]`, but we allow a slightly wider safe alphabet for forward-compatibility.
 */
export function isValidEntryId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export function serializeEntry(entry: NotebookEntry): string {
  const fm = [
    '---',
    `id: ${esc(entry.id)}`,
    `title: ${esc(entry.title)}`,
    `created_at: ${esc(entry.createdAt)}`,
    `model: ${esc(entry.model)}`,
    `source_app: ${esc(entry.sourceApp)}`,
    `source_kind: ${entry.sourceKind}`,
    `pinned: ${entry.pinned ? 'true' : 'false'}`,
    ...(entry.imagePath ? [`image: ${esc(entry.imagePath)}`] : []),
    `tags: ${serializeTags(entry.tags)}`,
    '---',
    '',
  ].join('\n');
  return `${fm}${entry.body}\n`;
}

/** Full parse of an entry file — every frontmatter field plus body. */
type ParsedFile = NotebookEntry;

/** Parse our own frontmatter format. Returns null if the block is missing/malformed. */
export function parseEntry(text: string): ParsedFile | null {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;

  const header = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n/, '');

  const e: NotebookEntry = {
    id: '', title: '', body: '', tags: [], model: '', sourceApp: '',
    sourceKind: 'text', pinned: false, createdAt: '',
  };
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === 'id') e.id = unesc(val);
    else if (key === 'title') e.title = unesc(val);
    else if (key === 'model') e.model = unesc(val);
    else if (key === 'source_app') e.sourceApp = unesc(val);
    else if (key === 'source_kind') e.sourceKind = val === 'image' ? 'image' : val === 'chat' ? 'chat' : val === 'drawing' ? 'drawing' : 'text';
    else if (key === 'created_at') e.createdAt = unesc(val);
    else if (key === 'image') e.imagePath = unesc(val);
    else if (key === 'pinned') e.pinned = val === 'true';
    else if (key === 'tags') {
      const raw = val.trim();
      // Strict-JSON form (written when a tag has a comma/bracket/quote/whitespace): decode
      // atomically so those tags survive intact. Falls through to the legacy bare-list parse
      // for `tags: [a, b]` files (invalid JSON — unquoted — so JSON.parse throws).
      let parsed: string[] | null = null;
      if (raw.startsWith('[') && raw.endsWith(']')) {
        try {
          const arr = JSON.parse(raw);
          // Only treat this as the strict-JSON form when EVERY element is a string.
          // A legacy/bare numeric or boolean list like `[2024]` JSON-parses to `[2024]`
          // (a number) — accepting it here and string-filtering would silently DROP the
          // tag. Falling through instead recovers it as the string tag "2024" via the
          // legacy split below.
          if (Array.isArray(arr) && arr.every((t) => typeof t === 'string')) parsed = arr as string[];
        } catch { /* not JSON — legacy bare list below */ }
      }
      if (parsed) {
        e.tags = parsed.filter(Boolean);
      } else {
        const inner = raw.replace(/^\[/, '').replace(/\]$/, '').trim();
        e.tags = inner.length ? inner.split(',').map((t) => unesc(t)).filter(Boolean) : [];
      }
    }
  }
  if (!e.id) return null;
  e.body = body.replace(/\n$/, '');
  return e;
}

export class MarkdownStore {
  // Cache of the previous listDiskEntries() scan, keyed by filename → { mtimeMs, entry }.
  // Lets the scan go stat-first: a file whose mtime is unchanged since we last read it is
  // returned from cache without a fresh readFileSync + frontmatter parse. Without this,
  // every focus-resync re-read and re-parsed every note body on the main thread.
  private scanCache = new Map<string, { mtimeMs: number; entry: DiskEntry }>();

  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  private pathFor(id: string): string {
    // Hard stop on traversal: the id becomes a filename, so it must be a safe token.
    if (!isValidEntryId(id)) throw new Error(`Invalid notebook entry id: ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.md`);
  }

  /** Write (or overwrite) an entry's file. Returns the file path. */
  write(entry: NotebookEntry): string {
    const path = this.pathFor(entry.id);
    // Atomic write (temp + rename) — this file is the source of truth, so a crash or
    // disk-full mid-write must never leave a truncated `.md` behind. rename() on the same
    // filesystem is atomic, matching the migration + sidecar writers.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, serializeEntry(entry), 'utf8');
    renameSync(tmp, path);
    return path;
  }

  /** Delete an entry's file (and its AI-block sidecar) if present. */
  delete(id: string): void {
    const path = this.pathFor(id);
    if (existsSync(path)) rmSync(path);
    // Remove the sidecars too so a deleted note doesn't leave orphaned metadata behind.
    writeSidecar(this.dir, id, []);
    writeDrawingSidecar(this.dir, id, []);
    // ponytail: leaves images/draw-<id>.png files behind; add a sweep to syncFromDisk if the
    // images dir grows unbounded (drawings are rare, so not worth a GC pass yet).
  }

  /** AI-block metadata for a note (empty if it has no sidecar). */
  readAiBlocks(id: string): AIBlockMeta[] {
    if (!isValidEntryId(id)) throw new Error(`Invalid notebook entry id: ${JSON.stringify(id)}`);
    return readSidecar(this.dir, id)?.blocks ?? [];
  }

  /** Persist a note's AI-block metadata (atomic; deletes the sidecar when there are none). */
  writeAiBlocks(id: string, blocks: AIBlockMeta[]): void {
    if (!isValidEntryId(id)) throw new Error(`Invalid notebook entry id: ${JSON.stringify(id)}`);
    writeSidecar(this.dir, id, blocks);
  }

  /** Re-editable drawing scenes for a note (empty if it has none). */
  readDrawings(id: string): DrawingMeta[] {
    if (!isValidEntryId(id)) throw new Error(`Invalid notebook entry id: ${JSON.stringify(id)}`);
    return readDrawingSidecar(this.dir, id)?.drawings ?? [];
  }

  /** Persist a note's drawing scenes (atomic; deletes the sidecar when there are none). */
  writeDrawings(id: string, drawings: DrawingMeta[]): void {
    if (!isValidEntryId(id)) throw new Error(`Invalid notebook entry id: ${JSON.stringify(id)}`);
    writeDrawingSidecar(this.dir, id, drawings);
  }

  /** Write a drawing's flattened PNG into images/ as `draw-<drawingId>.png` (for external
      viewers of the raw Markdown). `dataUrl` is a `data:image/png;base64,...` string. */
  storeDrawingPng(drawingId: string, dataUrl: string): void {
    if (!isValidEntryId(drawingId)) throw new Error(`Invalid drawing id: ${JSON.stringify(drawingId)}`);
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const imagesDir = join(this.dir, 'images');
    if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
    writeFileSync(join(imagesDir, `draw-${drawingId}.png`), Buffer.from(b64, 'base64'));
  }

  /** Copy a capture image into the notebook's images/ dir, keyed by entry id. Returns the
      stored absolute path (or the source unchanged if it's already inside images/). */
  storeImage(id: string, srcPath: string): string {
    if (!isValidEntryId(id)) throw new Error(`Invalid notebook entry id: ${JSON.stringify(id)}`);
    const imagesDir = join(this.dir, 'images');
    if (srcPath.startsWith(imagesDir)) return srcPath; // already stored
    if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });
    const dest = join(imagesDir, `${id}${extname(srcPath) || '.png'}`);
    copyFileSync(srcPath, dest);
    return dest;
  }

  /** Read one entry's raw parsed content, or null if absent/malformed. */
  read(id: string): ParsedFile | null {
    const path = this.pathFor(id);
    if (!existsSync(path)) return null;
    return parseEntry(readFileSync(path, 'utf8'));
  }

  /** List every valid `.md` entry on disk as a DiskEntry (id, body, tags, mtime).
   *  Stat-first: each file is stat()'d cheaply, and only files that are new or whose mtime
   *  changed since the last scan are read + parsed; unchanged files reuse the cached parse
   *  (identical DiskEntry, so reconcile reaches the same outcome). */
  listDiskEntries(): DiskEntry[] {
    if (!existsSync(this.dir)) {
      this.scanCache.clear();
      return [];
    }
    const out: DiskEntry[] = [];
    const nextCache = new Map<string, { mtimeMs: number; entry: DiskEntry }>();
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.md')) continue;
      const full = join(this.dir, file);
      // Isolate per-file failures: a single permission/race error on one file must not abort
      // the whole reconcile and hide every other note.
      try {
        const mtimeMs = statSync(full).mtimeMs;
        const cached = this.scanCache.get(file);
        if (cached && cached.mtimeMs === mtimeMs) {
          // Unchanged since the last scan — skip the readFileSync + parse entirely.
          out.push(cached.entry);
          nextCache.set(file, cached);
          continue;
        }
        const parsed = parseEntry(readFileSync(full, 'utf8'));
        if (!parsed) {
          // File is present but malformed. If its basename is a valid entry id, surface it as
          // an unparseable entry so reconcile keeps the existing row instead of tombstoning a
          // note whose file (with content) still sits on disk.
          const id = file.slice(0, -3);
          if (isValidEntryId(id)) {
            const entry: DiskEntry = { id, body: '', frontmatterTags: [], mtimeMs, unparseable: true };
            out.push(entry);
            nextCache.set(file, { mtimeMs, entry });
          }
          continue;
        }
        const entry: DiskEntry = {
          id: parsed.id,
          body: parsed.body,
          frontmatterTags: parsed.tags,
          mtimeMs,
          meta: {
            title: parsed.title || undefined,
            model: parsed.model || undefined,
            sourceApp: parsed.sourceApp || undefined,
            sourceKind: parsed.sourceKind,
            createdAt: parsed.createdAt || undefined,
            imagePath: parsed.imagePath || undefined,
            pinned: parsed.pinned,
          },
        };
        out.push(entry);
        nextCache.set(file, { mtimeMs, entry });
      } catch (e) {
        console.warn(`listDiskEntries: skipping unreadable file ${file}:`, e);
      }
    }
    // Swap in the fresh cache so deleted files drop out and don't leak.
    this.scanCache = nextCache;
    return out;
  }
}

/** Tiny helper so callers don't repeat the SourceKind union literal. */
export function makeEntry(
  fields: Omit<NotebookEntry, 'createdAt' | 'sourceKind' | 'title' | 'pinned'> & {
    createdAt?: string;
    sourceKind?: SourceKind;
    title?: string;
    pinned?: boolean;
  },
): NotebookEntry {
  return {
    ...fields,
    title: fields.title ?? '',
    pinned: fields.pinned ?? false,
    sourceKind: fields.sourceKind ?? 'text',
    createdAt: fields.createdAt ?? new Date().toISOString(),
  };
}
