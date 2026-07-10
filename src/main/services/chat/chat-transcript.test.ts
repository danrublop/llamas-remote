import { describe, it, expect } from 'vitest';
import { serializeTranscript, parseTranscript, type ChatTurn } from './chat-transcript';

const turns: ChatTurn[] = [
  { role: 'user', content: 'what does my billing note say?', ts: '2026-07-09T00:00:00Z' },
  { role: 'assistant', content: 'Your billing note says X.', model: 'mistral:latest', cites: ['a1b2', 'c3d4'], ts: '2026-07-09T00:00:05Z' },
  { role: 'user', content: 'thanks' },
];

describe('chat transcript round-trip', () => {
  it('serializes and parses back to the same turns', () => {
    expect(parseTranscript(serializeTranscript(turns))).toEqual(turns);
  });

  it('carries model + citations on assistant anchors', () => {
    const md = serializeTranscript(turns);
    expect(md).toContain('<!--chat:assistant model="mistral:latest" cites="a1b2,c3d4"');
    const back = parseTranscript(md);
    expect(back[1].model).toBe('mistral:latest');
    expect(back[1].cites).toEqual(['a1b2', 'c3d4']);
  });

  it('preserves multi-line and markdown content', () => {
    const t: ChatTurn[] = [{ role: 'assistant', content: '# Heading\n\n- a\n- b\n\n**bold**', model: 'x' }];
    expect(parseTranscript(serializeTranscript(t))[0].content).toBe('# Heading\n\n- a\n- b\n\n**bold**');
  });

  it('treats an anchorless body as an empty chat (graceful degradation)', () => {
    expect(parseTranscript('just some prose a user pasted')).toEqual([]);
    expect(parseTranscript('')).toEqual([]);
  });
});
