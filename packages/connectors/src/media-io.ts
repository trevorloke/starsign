import { randomBytes } from "node:crypto";
import type { Media } from "@starsign/schema";
import { downloadMedia, resolveFetch, type FetchLike } from "./http.ts";
import { ConnectorError, type MediaFetcher } from "./types.ts";

/**
 * Streamed media for upload-style connectors. A 4 GB video must never sit in memory as one Uint8Array, so connectors
 * open a MediaReader and take the file one chunk (or one request body, read piece by piece) at a time. Fetchers that
 * only implement `fetch` (tests, older callers) still work: the reader then holds the bytes they returned.
 */

/** Size of each read when a body is pulled from ranged reads (an S3 GET per piece). */
export const STREAM_PIECE_BYTES = 4 * 1024 * 1024;

/** A request body with a known length that is read as it is sent. `open()` gives a fresh stream for each attempt. */
export interface StreamBody {
  readonly length: number;
  readonly type: string;
  open(): ReadableStream<Uint8Array>;
}

export interface MediaReader {
  readonly size: number;
  readonly mime: string;
  /** The whole file when the fetcher could only hand it over in one piece; null when it is read in ranges. */
  readonly bytes: Uint8Array | null;
  /** Bytes [start, start + length). */
  read(start: number, length: number): Promise<Uint8Array>;
  /** The file in consecutive chunks of `chunkSize` bytes (the last may be shorter); one chunk is resident at a time. */
  chunks(chunkSize: number): AsyncGenerator<Uint8Array>;
  /** Bytes [start, start + length) as a request body, read piece by piece while it is sent. */
  body(start?: number, length?: number, type?: string): StreamBody;
  /** Release any open download. */
  close(): Promise<void>;
}

/** The connector's fetcher, or (when core has not set one) a plain download of media.url. */
export function mediaSource(fetcher: MediaFetcher | undefined, fetchImpl: FetchLike | undefined): MediaFetcher {
  return fetcher ?? { fetch: (m) => downloadMedia(resolveFetch(fetchImpl), m) };
}

/**
 * Open a media item for reading. Ranged when the fetcher knows the size and can read ranges; else streamed when it can
 * stream with a known length; else (and for fetchers that only `fetch`) the whole file, as before.
 */
export async function openMedia(fetcher: MediaFetcher, media: Media): Promise<MediaReader> {
  if (fetcher.size && fetcher.range) {
    const size = await fetcher.size(media);
    if (size !== null) return new RangedReader(fetcher, media, size, guessMime(media));
  }
  if (fetcher.stream) {
    const s = await fetcher.stream(media);
    if (s.size !== null) return new StreamedReader(fetcher, media, s.size, media.mime ?? s.mime, s.body);
    // Unknown length: every upload protocol needs the size up front, so this one is read whole.
    return new BufferedReader(await collect(s.body), media.mime ?? s.mime);
  }
  const { bytes, mime } = await fetcher.fetch(media);
  return new BufferedReader(bytes, mime);
}

/**
 * For connectors that upload many kinds of media: videos and documents are opened for streaming (openMedia); images
 * and GIFs are read whole through `fetch`, exactly as before.
 */
export async function openForUpload(fetcher: MediaFetcher, media: Media): Promise<MediaReader> {
  if (media.kind === "video" || media.kind === "document") return openMedia(fetcher, media);
  const { bytes, mime } = await fetcher.fetch(media);
  return new BufferedReader(bytes, mime);
}

/** openForUpload, use, and always release. */
export async function withUpload<T>(fetcher: MediaFetcher, media: Media, fn: (r: MediaReader) => Promise<T>): Promise<T> {
  const r = await openForUpload(fetcher, media);
  try {
    return await fn(r);
  } finally {
    await r.close();
  }
}

/** Open, use, and always release a media reader. */
export async function withMedia<T>(fetcher: MediaFetcher, media: Media, fn: (r: MediaReader) => Promise<T>): Promise<T> {
  const r = await openMedia(fetcher, media);
  try {
    return await fn(r);
  } finally {
    await r.close();
  }
}

/**
 * The file in chunks of `chunkSize` bytes via `range` (falling back to slicing `fetch` for fetchers without ranges),
 * so a caller never holds more than one chunk.
 */
export async function* readChunks(fetcher: MediaFetcher, media: Media, chunkSize: number): AsyncGenerator<Uint8Array> {
  const r = await openMedia(fetcher, media);
  try {
    yield* r.chunks(chunkSize);
  } finally {
    await r.close();
  }
}

/** RequestInit fields for sending a StreamBody: the stream, an exact Content-Length, and `duplex: "half"` (Node fetch). */
export function streamInit(b: StreamBody, headers: Record<string, string> = {}): { body: ReadableStream<Uint8Array>; headers: Record<string, string>; duplex: "half" } {
  return { body: b.open(), headers: { "content-type": b.type, ...headers, "content-length": String(b.length) }, duplex: "half" };
}

/** fetch(url, init) with a streamed body. */
export function sendStream(fetchImpl: FetchLike, url: string, init: Omit<RequestInit, "body" | "headers"> & { headers?: Record<string, string> }, b: StreamBody): Promise<Response> {
  const s = streamInit(b, init.headers);
  return fetchImpl(url, { ...init, ...s } as RequestInit);
}

// ---- readers ----------------------------------------------------------------------------

abstract class BaseReader implements MediaReader {
  abstract readonly size: number;
  abstract readonly mime: string;
  readonly bytes: Uint8Array | null = null;
  abstract read(start: number, length: number): Promise<Uint8Array>;
  protected piece = STREAM_PIECE_BYTES;

  async *chunks(chunkSize: number): AsyncGenerator<Uint8Array> {
    if (!(chunkSize > 0)) throw new Error("chunkSize must be positive");
    for (let offset = 0; offset < this.size; offset += chunkSize) yield await this.read(offset, Math.min(chunkSize, this.size - offset));
  }

  body(start = 0, length = this.size - start, type = this.mime): StreamBody {
    const end = Math.min(this.size, start + length);
    const n = Math.max(0, end - start);
    return {
      length: n,
      type,
      open: () =>
        streamFrom(
          (async function* (self: BaseReader) {
            for (let p = start; p < end; p += self.piece) yield await self.read(p, Math.min(self.piece, end - p));
          })(this),
        ),
    };
  }

  async close(): Promise<void> {}

  protected check(got: Uint8Array, start: number, length: number): Uint8Array {
    if (got.byteLength !== length) throw new ConnectorError(`reading media: asked for ${length} bytes at ${start}, got ${got.byteLength}`, "network", true);
    return got;
  }
}

class BufferedReader extends BaseReader {
  override readonly bytes: Uint8Array;
  readonly size: number;
  constructor(
    bytes: Uint8Array,
    readonly mime: string,
  ) {
    super();
    this.bytes = bytes;
    this.size = bytes.byteLength;
  }
  async read(start: number, length: number): Promise<Uint8Array> {
    return this.bytes.subarray(start, start + length);
  }
}

class RangedReader extends BaseReader {
  constructor(
    private readonly fetcher: MediaFetcher,
    private readonly media: Media,
    readonly size: number,
    readonly mime: string,
  ) {
    super();
  }
  async read(start: number, length: number): Promise<Uint8Array> {
    length = Math.min(length, this.size - start);
    if (length <= 0) return new Uint8Array();
    return this.check(await this.fetcher.range!(this.media, start, length), start, length);
  }
  override body(start = 0, length = this.size - start, type = this.mime): StreamBody {
    // The whole file in one GET when the fetcher can stream it; ranged pieces otherwise.
    if (start !== 0 || length < this.size || !this.fetcher.stream) return super.body(start, length, type);
    const { fetcher, media, size } = this;
    return {
      length: size,
      type,
      open: () =>
        streamFrom(
          (async function* () {
            const s = await fetcher.stream!(media);
            yield* exactly(s.body, size);
          })(),
        ),
    };
  }
}

/** For sources without Range support: one sequential download, reopened only when a caller goes backwards. */
class StreamedReader extends BaseReader {
  private cursor: { reader: ReadableStreamDefaultReader<Uint8Array>; pos: number; rest: Uint8Array | null } | null;
  constructor(
    private readonly fetcher: MediaFetcher,
    private readonly media: Media,
    readonly size: number,
    readonly mime: string,
    first: ReadableStream<Uint8Array>,
  ) {
    super();
    this.cursor = { reader: first.getReader(), pos: 0, rest: null };
  }
  async read(start: number, length: number): Promise<Uint8Array> {
    length = Math.min(length, this.size - start);
    if (length <= 0) return new Uint8Array();
    if (!this.cursor || this.cursor.pos > start) {
      await this.close();
      const s = await this.fetcher.stream!(this.media);
      this.cursor = { reader: s.body.getReader(), pos: 0, rest: null };
    }
    const c = this.cursor;
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      let piece = c.rest;
      c.rest = null;
      if (!piece) {
        const r = await c.reader.read();
        if (r.done) break;
        piece = r.value;
      }
      // Skip what lies before `start`.
      if (c.pos < start) {
        const skip = Math.min(piece.byteLength, start - c.pos);
        c.pos += skip;
        piece = piece.subarray(skip);
        if (piece.byteLength === 0) continue;
      }
      const take = Math.min(piece.byteLength, length - filled);
      out.set(piece.subarray(0, take), filled);
      filled += take;
      c.pos += take;
      if (take < piece.byteLength) c.rest = piece.subarray(take);
    }
    return this.check(out.subarray(0, filled), start, length);
  }
  override async close(): Promise<void> {
    const c = this.cursor;
    this.cursor = null;
    if (c) await c.reader.cancel().catch(() => undefined);
  }
}

// ---- multipart ----------------------------------------------------------------------------

type Part = { name: string; head: Uint8Array; body: StreamBody | Uint8Array };

/**
 * multipart/form-data built as a stream with an exact Content-Length: boundary and headers, then each file read piece
 * by piece, then the closing boundary. Same wire format and `set` semantics as FormData.
 */
export class StreamingForm implements StreamBody {
  readonly boundary = `----starsign${randomBytes(12).toString("hex")}`;
  private readonly parts: Part[] = [];

  get type(): string {
    return `multipart/form-data; boundary=${this.boundary}`;
  }

  get length(): number {
    const tail = utf8(`--${this.boundary}--\r\n`).byteLength;
    return this.parts.reduce((n, p) => n + p.head.byteLength + (p.body instanceof Uint8Array ? p.body.byteLength : p.body.length) + 2, tail);
  }

  /** A text field, or a Blob (filename defaults to "blob", as FormData does). */
  set(name: string, value: string | Blob, filename?: string): void {
    if (typeof value === "string") {
      this.put({ name, head: utf8(`--${this.boundary}\r\nContent-Disposition: form-data; name="${esc(name)}"\r\n\r\n`), body: utf8(value.replace(/\r(?!\n)|(?<!\r)\n/g, "\r\n")) });
      return;
    }
    const blob = value;
    this.setFile(name, { length: blob.size, type: blob.type || "application/octet-stream", open: () => blob.stream() as ReadableStream<Uint8Array> }, filename ?? "blob");
  }

  /** A file part read from `body` while the request is sent. */
  setFile(name: string, body: StreamBody, filename: string): void {
    const head = utf8(`--${this.boundary}\r\nContent-Disposition: form-data; name="${esc(name)}"; filename="${esc(filename)}"\r\nContent-Type: ${body.type || "application/octet-stream"}\r\n\r\n`);
    this.put({ name, head, body });
  }

  open(): ReadableStream<Uint8Array> {
    const parts = [...this.parts];
    const boundary = this.boundary;
    return streamFrom(
      (async function* () {
        for (const p of parts) {
          yield p.head;
          if (p.body instanceof Uint8Array) yield p.body;
          else yield* exactly(p.body.open(), p.body.length);
          yield CRLF;
        }
        yield utf8(`--${boundary}--\r\n`);
      })(),
    );
  }

  private put(p: Part): void {
    const i = this.parts.findIndex((x) => x.name === p.name);
    if (i < 0) {
      this.parts.push(p);
      return;
    }
    this.parts[i] = p;
    for (let j = this.parts.length - 1; j > i; j--) if (this.parts[j]!.name === p.name) this.parts.splice(j, 1);
  }
}

/** A FormData when every file is already in memory (the old behaviour), else a StreamingForm. */
export function uploadForm(readers: MediaReader[]): FormData | StreamingForm {
  return readers.every((r) => r.bytes) ? new FormData() : new StreamingForm();
}

/** Put a media file in either kind of form. */
export function setMediaFile(form: FormData | StreamingForm, name: string, r: MediaReader, filename: string, type = r.mime): void {
  if (form instanceof FormData) form.set(name, new Blob([r.bytes ?? new Uint8Array()], { type }), filename);
  else form.setFile(name, r.body(0, r.size, type), filename);
}

/** The body for fetch: a raw Uint8Array when the file is in memory (the old behaviour), else a StreamBody. */
export function rawBody(r: MediaReader, type = r.mime): Uint8Array | StreamBody {
  return r.bytes ?? r.body(0, r.size, type);
}

/** Bytes [start, start + length) as a body: a subarray when the file is in memory, else a StreamBody. */
export function rangeBody(r: MediaReader, start: number, length: number, type = r.mime): Uint8Array | StreamBody {
  return r.bytes ? r.bytes.subarray(start, start + length) : r.body(start, length, type);
}

/**
 * fetch(url, init) where `body` may be a StreamBody (StreamingForm included): it is then sent as a stream with an
 * exact Content-Length. Any other body (FormData, bytes, string) is passed through untouched.
 */
export function sendBody(fetchImpl: FetchLike, url: string, init: Omit<RequestInit, "body" | "headers"> & { headers?: Record<string, string> }, body: unknown): Promise<Response> {
  if (isStreamBody(body)) return sendStream(fetchImpl, url, init, body);
  return fetchImpl(url, { ...init, ...(body !== undefined ? { body: body as RequestInit["body"] } : {}) } as RequestInit);
}

export function isStreamBody(x: unknown): x is StreamBody {
  return typeof x === "object" && x !== null && typeof (x as StreamBody).open === "function" && typeof (x as StreamBody).length === "number" && !(x instanceof Blob);
}

// ---- helpers ------------------------------------------------------------------------------

const CRLF = Uint8Array.from([13, 10]);
const encoder = new TextEncoder();
function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}
function esc(s: string): string {
  return s.replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22");
}

/** A pull-based stream over an async generator: nothing is read until the consumer asks for it. */
export function streamFrom(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        try {
          const r = await gen.next();
          if (r.done) c.close();
          else if (r.value.byteLength > 0) c.enqueue(r.value);
        } catch (err) {
          c.error(err);
        }
      },
      async cancel() {
        await gen.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Yield a stream's pieces, failing if it ends short of or runs past `length` (the declared Content-Length). */
async function* exactly(stream: ReadableStream<Uint8Array>, length: number): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let seen = 0;
  let done = false;
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) {
        done = true;
        break;
      }
      seen += r.value.byteLength;
      if (seen > length) throw new ConnectorError(`reading media: the file is larger than the ${length} bytes announced`, "network", true);
      yield r.value;
    }
    if (seen !== length) throw new ConnectorError(`reading media: got ${seen} of ${length} bytes`, "network", true);
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let n = 0;
  const reader = stream.getReader();
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
    n += r.value.byteLength;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

const EXT_MIME: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", gif: "image/gif", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", pdf: "application/pdf" };

/** media.mime, else from the URL's extension, else a default for the kind. */
export function guessMime(m: Media): string {
  if (m.mime) return m.mime;
  try {
    const ext = new URL(m.url).pathname.split(".").pop()?.toLowerCase() ?? "";
    if (EXT_MIME[ext]) return EXT_MIME[ext]!;
  } catch {
    /* not a URL */
  }
  return m.kind === "video" ? "video/mp4" : m.kind === "gif" ? "image/gif" : m.kind === "document" ? "application/pdf" : "image/jpeg";
}
