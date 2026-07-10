// Chat transcript ⇄ markdown. A chat note's `.md` body IS the conversation, with each turn
// preceded by an HTML-comment anchor carrying its role + metadata — the same anchor+reconstruct
// pattern the AI block uses (see editor/reconstruct.ts). Markdown stays the single source of
// truth: the transcript is human-readable, RAG-searchable, portable, and survives external edits.
//
//   <!--chat:user ts="…"-->
//   what does my billing note say?
//   <!--chat:assistant model="mistral:latest" cites="a1b2,c3d4" ts="…"-->
//   Your billing note says …

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  model?: string;      // assistant turns: which model produced it
  cites?: string[];    // assistant turns: retrieved note ids used as context
  ts?: string;         // ISO 8601
}

const ANCHOR = /<!--chat:(user|assistant)([^>]*)-->/g;

function attrs(turn: ChatTurn): string {
  const parts: string[] = [];
  if (turn.model) parts.push(`model="${turn.model}"`);
  if (turn.cites && turn.cites.length) parts.push(`cites="${turn.cites.join(',')}"`);
  if (turn.ts) parts.push(`ts="${turn.ts}"`);
  return parts.length ? ' ' + parts.join(' ') : '';
}

/** Turns → markdown body. */
export function serializeTranscript(turns: ChatTurn[]): string {
  return turns.map((t) => `<!--chat:${t.role}${attrs(t)}-->\n${t.content}`.trim()).join('\n\n');
}

function parseAttr(raw: string, key: string): string | undefined {
  const m = new RegExp(`${key}="([^"]*)"`).exec(raw);
  return m ? m[1] : undefined;
}

/**
 * Markdown body → turns. Content is whatever sits between one anchor and the next.
 * A body with no anchors (e.g. an externally-created note) yields a single empty list —
 * callers treat "no turns" as an empty chat, degrading gracefully like the AI block does.
 */
export function parseTranscript(body: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const matches = [...body.matchAll(ANCHOR)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const rawAttrs = m[2] ?? '';
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : body.length;
    const content = body.slice(start, end).trim();
    const cites = parseAttr(rawAttrs, 'cites');
    turns.push({
      role: m[1] as ChatTurn['role'],
      content,
      model: parseAttr(rawAttrs, 'model'),
      cites: cites ? cites.split(',').filter(Boolean) : undefined,
      ts: parseAttr(rawAttrs, 'ts'),
    });
  }
  return turns;
}
