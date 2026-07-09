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

function esc(value: string): string {
  // Quote scalars that could confuse the minimal parser.
  return /[:#\n]/.test(value) ? JSON.stringify(value) : value;
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
  const tags = entry.tags.map(esc).join(', ');
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
    `tags: [${tags}]`,
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
    else if (key === 'source_kind') e.sourceKind = val === 'image' ? 'image' : 'text';
    else if (key === 'created_at') e.createdAt = unesc(val);
    else if (key === 'image') e.imagePath = unesc(val);
    else if (key === 'pinned') e.pinned = val === 'true';
    else if (key === 'tags') {
      const inner = val.replace(/^\[/, '').replace(/\]$/, '').trim();
      e.tags = inner.length ? inner.split(',').map((t) => unesc(t)).filter(Boolean) : [];
    }
  }
  if (!e.id) return null;
  e.body = body.replace(/\n$/, '');
  return e;
}

export class MarkdownStore {
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
    // Remove the sidecar too so a deleted note doesn't leave orphaned AI-block metadata behind.
    writeSidecar(this.dir, id, []);
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

  /** List every valid `.md` entry on disk as a DiskEntry (id, body, tags, mtime). */
  listDiskEntries(): DiskEntry[] {
    if (!existsSync(this.dir)) return [];
    const out: DiskEntry[] = [];
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.md')) continue;
      const full = join(this.dir, file);
      const parsed = parseEntry(readFileSync(full, 'utf8'));
      if (!parsed) continue;
      out.push({
        id: parsed.id,
        body: parsed.body,
        frontmatterTags: parsed.tags,
        mtimeMs: statSync(full).mtimeMs,
        meta: {
          title: parsed.title || undefined,
          model: parsed.model || undefined,
          sourceApp: parsed.sourceApp || undefined,
          sourceKind: parsed.sourceKind,
          createdAt: parsed.createdAt || undefined,
          imagePath: parsed.imagePath || undefined,
        },
      });
    }
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
