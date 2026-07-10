// Sentence-boundary-aware chunking for embeddings (pattern from Odysseus's rag_vector.py).
// A note is split into ~`size`-char chunks that break on sentence/line boundaries, with a
// trailing `overlap` carried into the next chunk so context isn't lost at a split. A single
// oversized sentence is hard char-split so no chunk ever exceeds `size`.

export function splitIntoChunks(text: string, size = 1000, overlap = 200): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  // Pieces = sentences (ending in . ! ? or newline) plus any trailing remainder.
  const pieces = clean.match(/[^.!?\n]*[.!?\n]+|[^.!?\n]+$/g) ?? [clean];
  const chunks: string[] = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };

  for (let piece of pieces) {
    // A single piece longer than a whole chunk: emit it in hard char slices with overlap.
    while (piece.length > size) {
      flush();
      chunks.push(piece.slice(0, size).trim());
      piece = piece.slice(size - overlap);
    }
    if (cur.length + piece.length > size) {
      const tail = cur.slice(-overlap); // carry overlap into the next chunk
      flush();
      cur = tail + piece;
    } else {
      cur += piece;
    }
  }
  flush();
  return chunks;
}
