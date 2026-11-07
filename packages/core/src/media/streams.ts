/** Small web-stream helpers for media reads that must not hold a whole file. */

/**
 * Bytes [start, start + length) of a stream, read and dropped piece by piece up to `start`; the stream is cancelled
 * once the slice is complete. Used when a server ignores Range and sends the whole file.
 */
export async function sliceStream(body: ReadableStream<Uint8Array> | null, start: number, length: number): Promise<Uint8Array> {
  if (!body || length <= 0) {
    await body?.cancel().catch(() => undefined);
    return new Uint8Array();
  }
  const reader = body.getReader();
  const out = new Uint8Array(length);
  let pos = 0;
  let filled = 0;
  try {
    while (filled < length) {
      const r = await reader.read();
      if (r.done) break;
      let piece = r.value;
      if (pos < start) {
        const skip = Math.min(piece.byteLength, start - pos);
        pos += skip;
        piece = piece.subarray(skip);
      }
      const take = Math.min(piece.byteLength, length - filled);
      out.set(piece.subarray(0, take), filled);
      filled += take;
      pos += take;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out.subarray(0, filled);
}

/** An empty stream (for zero-length objects). */
export function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: (c) => c.close() });
}
