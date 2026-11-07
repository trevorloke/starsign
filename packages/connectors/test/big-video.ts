/**
 * Test helpers for streamed uploads: a 50 MB fake video served by a MediaFetcher that records the largest single read
 * (and refuses `fetch` for it), and a fake network that drains every request body the way a real server would.
 */
import { expect, vi } from "vitest";
import type { Media } from "@starsign/schema";
import type { MediaFetcher } from "../src/index.ts";

export const MiB = 1024 * 1024;

/** Byte i of the fake file. */
export const byteAt = (i: number) => (i * 31 + 7) & 255;

function fill(start: number, n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = byteAt(start + i);
  return b;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);

export interface BigVideoStats {
  /** Largest number of bytes handed over by one range read or one stream piece. */
  maxRead: number;
  reads: number;
  bytesRead: number;
  /** fetch() calls for the video (must stay 0). */
  fetchCalls: number;
}

/**
 * A fetcher over a `size`-byte video. Images (thumbnails, posters) come from `fetch` as a tiny PNG; the video only
 * through size/range/stream, so a connector that buffers it fails loudly.
 */
export function bigVideo(size = 50 * MiB, opts: { stream?: boolean } = {}): { fetcher: MediaFetcher; stats: BigVideoStats; media: Media; size: number } {
  const stats: BigVideoStats = { maxRead: 0, reads: 0, bytesRead: 0, fetchCalls: 0 };
  const note = (n: number) => {
    stats.maxRead = Math.max(stats.maxRead, n);
    stats.reads++;
    stats.bytesRead += n;
  };
  const fetcher: MediaFetcher = {
    fetch: async (m) => {
      if (m.kind === "image") return { bytes: PNG, mime: "image/png" };
      stats.fetchCalls++;
      throw new Error("fetch() must not be used for a large video");
    },
    size: async () => size,
    range: async (_m, start, length) => {
      const n = Math.max(0, Math.min(length, size - start));
      note(n);
      return fill(start, n);
    },
    ...(opts.stream === false
      ? {}
      : {
          stream: async () => {
            let pos = 0;
            const body = new ReadableStream<Uint8Array>(
              {
                pull(c) {
                  if (pos >= size) return c.close();
                  const n = Math.min(MiB, size - pos);
                  note(n);
                  c.enqueue(fill(pos, n));
                  pos += n;
                },
              },
              { highWaterMark: 0 },
            );
            return { body, size, mime: "video/mp4" };
          },
        }),
  };
  return { fetcher, stats, size, media: { kind: "video", url: "https://media.example/big.mp4", mime: "video/mp4", bytes: size } };
}

export interface SentRequest {
  url: URL;
  method: string;
  headers: Headers;
  /** Bytes in the request body. */
  sent: number;
  /** True when the body was a stream (sent with an exact Content-Length). */
  streamed: boolean;
  /** Largest single piece of a streamed body. */
  maxPiece: number;
  /** The body when it was small enough to keep (JSON, form fields), as text. */
  text: string | null;
  /** Multipart file parts found in a streamed body: name and byte count. */
  fileParts: { name: string; filename: string; bytes: number }[];
  init: RequestInit;
}

/** Read a request body the way a server would, without keeping it. */
async function drain(init: RequestInit | undefined): Promise<Omit<SentRequest, "url" | "method" | "headers" | "init">> {
  const body = init?.body;
  const out = { sent: 0, streamed: false, maxPiece: 0, text: null as string | null, fileParts: [] as SentRequest["fileParts"] };
  if (body == null) return out;
  if (typeof body === "string") return { ...out, sent: Buffer.byteLength(body), text: body };
  if (body instanceof URLSearchParams) return { ...out, sent: body.toString().length, text: body.toString() };
  if (body instanceof Uint8Array) return { ...out, sent: body.byteLength, text: body.byteLength < 64 * 1024 ? Buffer.from(body).toString() : null };
  if (body instanceof Blob) return { ...out, sent: body.size, text: body.size < 64 * 1024 ? await body.text() : null };
  if (body instanceof FormData) {
    let n = 0;
    for (const [name, v] of body) {
      const size = typeof v === "string" ? Buffer.byteLength(v) : v.size;
      n += size;
      if (typeof v !== "string") out.fileParts.push({ name, filename: (v as File).name, bytes: v.size });
    }
    return { ...out, sent: n };
  }
  if (body instanceof ReadableStream) {
    expect((init as { duplex?: string }).duplex).toBe("half");
    const headers = new Headers(init?.headers);
    const declared = Number(headers.get("content-length"));
    const boundary = /boundary=([^;]+)/.exec(headers.get("content-type") ?? "")?.[1];
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    let n = 0;
    let maxPiece = 0;
    // Keep only a small window to find multipart headers; never the payload.
    let head = "";
    const parts: SentRequest["fileParts"] = [];
    let current: SentRequest["fileParts"][number] | null = null;
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      n += r.value.byteLength;
      maxPiece = Math.max(maxPiece, r.value.byteLength);
      if (boundary && r.value.byteLength < 4096) {
        // StreamingForm sends part headers and boundaries as their own small pieces.
        head = Buffer.from(r.value).toString("latin1");
        const m = /name="([^"]*)"; filename="([^"]*)"/.exec(head);
        if (m) {
          current = { name: m[1]!, filename: m[2]!, bytes: 0 };
          parts.push(current);
          continue;
        }
        if (head.startsWith("--") || head === "\r\n") {
          current = null;
          continue;
        }
      }
      if (current) current.bytes += r.value.byteLength;
    }
    expect(n).toBe(declared);
    return { ...out, sent: n, streamed: true, maxPiece, fileParts: parts };
  }
  throw new Error(`unexpected body type ${Object.prototype.toString.call(body)}`);
}

export type Route = (req: SentRequest) => Response | Promise<Response> | undefined;

/** Stub global fetch with a router that drains every body first. */
export function network(route: Route) {
  const sent: SentRequest[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const d = await drain(init);
    const req: SentRequest = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), init: init ?? {}, ...d };
    sent.push(req);
    const res = await route(req);
    if (!res) throw new Error(`unexpected ${req.method} ${url}`);
    return res;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { sent, fetchMock };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
