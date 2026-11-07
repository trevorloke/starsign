import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "@starsign/db/test";
import type { DbHandle } from "@starsign/db";
import { ConnectorRegistry, MockConnector, openMedia, readChunks, type MediaFetcher } from "@starsign/connectors";
import type { Media } from "@starsign/schema";
import { InMemoryScheduler, LocalStorage, S3Storage, SecretBox, Starsign, type Principal } from "../src/index.ts";

const MiB = 1024 * 1024;
const byteAt = (i: number) => (i * 13 + 5) & 255;
function pattern(n: number, from = 0): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = byteAt(from + i);
  return b;
}
/** An MP4 the upload sniffer accepts: ftyp then `size` bytes of media data (patterned). */
function mp4(size: number): Uint8Array {
  const out = pattern(size);
  out.set([0, 0, 0, 16, ...Buffer.from("ftypisom"), 0, 0, 0, 0], 0);
  return out;
}
/** Byte equality without vitest's slow deep diff on megabyte arrays. */
function expectSame(a: Uint8Array, b: Uint8Array) {
  expect(a.length).toBe(b.length);
  expect(Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength))).toBe(0);
}
async function drain(s: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; maxPiece: number }> {
  const parts: Uint8Array[] = [];
  let maxPiece = 0;
  for (const reader = s.getReader(); ; ) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
    maxPiece = Math.max(maxPiece, r.value.byteLength);
  }
  return { bytes: new Uint8Array(Buffer.concat(parts)), maxPiece };
}

/** S3 in memory: signed PUT/HEAD/GET (with or without Range support)/DELETE. Records the largest response body. */
class FakeBucket {
  objects = new Map<string, { bytes: Uint8Array; type: string }>();
  ranges = true;
  maxServed = 0;
  gets = 0;
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (!headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256 ")) return new Response("unsigned", { status: 403 });
    if (method === "PUT") {
      this.objects.set(key, { bytes: new Uint8Array(init!.body as Uint8Array), type: headers.get("content-type") ?? "" });
      return new Response(null, { status: 200 });
    }
    const obj = this.objects.get(key);
    if (method === "HEAD") return obj ? new Response(null, { status: 200, headers: { "content-length": String(obj.bytes.length), "content-type": obj.type } }) : new Response(null, { status: 404 });
    if (method === "GET") {
      if (!obj) return new Response("missing", { status: 404 });
      this.gets++;
      const m = this.ranges ? /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "") : null;
      const part = m ? obj.bytes.subarray(Number(m[1]), Math.min(obj.bytes.length, Number(m[2]) + 1)) : obj.bytes;
      this.maxServed = Math.max(this.maxServed, m ? part.length : 0);
      // The whole object goes out in 256 KB pieces, like a network body.
      let pos = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (pos >= part.length) return c.close();
          c.enqueue(part.slice(pos, pos + 256 * 1024));
          pos += 256 * 1024;
        },
      });
      return new Response(body, { status: m ? 206 : 200, headers: { "content-length": String(part.length) } });
    }
    return new Response("unsupported", { status: 400 });
  };
}

/** An external web server for media URLs, with or without byte-range support. */
function webServer(file: Uint8Array, opts: { ranges: boolean }) {
  const stats = { heads: 0, gets: 0, rangeGets: 0 };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const common = { "content-type": "video/mp4", ...(opts.ranges ? { "accept-ranges": "bytes" } : {}) };
    if (method === "HEAD") {
      stats.heads++;
      return new Response(null, { status: 200, headers: { ...common, "content-length": String(file.length) } });
    }
    stats.gets++;
    const m = opts.ranges ? /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "") : null;
    if (m) {
      stats.rangeGets++;
      const s = Number(m[1]);
      const part = file.slice(s, Math.min(file.length, Number(m[2]) + 1));
      return new Response(part, { status: 206, headers: { ...common, "content-length": String(part.length), "content-range": `bytes ${s}-${s + part.length - 1}/${file.length}` } });
    }
    let pos = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pos >= file.length) return c.close();
        c.enqueue(file.slice(pos, pos + 64 * 1024));
        pos += 64 * 1024;
      },
    });
    return new Response(body, { status: 200, headers: { ...common, "content-length": String(file.length) } });
  }) as typeof fetch;
  return { fetchImpl, stats };
}

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

async function starsign(storage: LocalStorage | S3Storage) {
  const m = new Starsign({ handle: h, connectors: new ConnectorRegistry().register(new MockConnector()), scheduler: new InMemoryScheduler(), secrets: new SecretBox(randomBytes(32)), mediaStorage: storage });
  const ws = await m.workspaces.create({ slug: `ws${randomBytes(4).toString("hex")}`, name: "Acme", timezone: "UTC" }, { type: "human", id: "u1" });
  const owner: Principal = { workspaceId: ws.id, actor: { type: "human", id: "u1" }, role: "owner" };
  return { m, owner };
}

/** The checks every source must pass: size, an inner range, a range past the end, the stream, and chunked reads. */
async function expectReads(fetcher: MediaFetcher, media: Media, file: Uint8Array) {
  expect(await fetcher.size!(media)).toBe(file.length);
  expectSame(await fetcher.range!(media, 1000, 4096), file.slice(1000, 5096));
  expectSame(await fetcher.range!(media, file.length - 10, 100), file.slice(file.length - 10));
  const s = await fetcher.stream!(media);
  expect(s.size).toBe(file.length);
  expect(s.mime).toBe("video/mp4");
  const { bytes, maxPiece } = await drain(s.body);
  expectSame(bytes, file);
  expect(maxPiece).toBeLessThanOrEqual(MiB);
  const chunks: number[] = [];
  let at = 0;
  for await (const c of readChunks(fetcher, media, MiB)) {
    expectSame(c, file.subarray(at, at + c.length));
    at += c.length;
    chunks.push(c.length);
  }
  expect(chunks).toEqual([MiB, MiB, MiB, file.length - 3 * MiB]);
}

describe("media fetcher on local disk", () => {
  it("serves size, positional ranges, a 1 MB-piece stream and chunks for an uploaded video", async () => {
    const { m, owner } = await starsign(new LocalStorage(mkdtempSync(join(tmpdir(), "ss-")), "http://localhost:4000"));
    const file = mp4(3 * MiB + 777);
    const row = await m.media.upload(owner, { bytes: file, filename: "clip.mp4" });
    await expectReads(m.media.fetcher(), m.media.toMedia(row), file);
  });

  it("LocalStorage: head of a missing key is null, a short file streams and an empty one closes at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    const local = new LocalStorage(dir, "http://localhost:4000");
    expect(await local.head("ws/missing.mp4")).toBeNull();
    writeFileSync(join(dir, "empty.bin"), new Uint8Array());
    const empty = await local.stream("empty.bin");
    expect(empty.size).toBe(0);
    expect((await drain(empty.body)).bytes.length).toBe(0);
    writeFileSync(join(dir, "small.bin"), Uint8Array.from([1, 2, 3]));
    expect(await local.head("small.bin")).toEqual({ bytes: 3, mime: null, etag: null });
    expect([...(await local.getRange("small.bin", 1, 10))]).toEqual([2, 3]);
    const s = await local.stream("small.bin");
    await s.body.cancel(); // cancelling closes the file handle
  });
});

describe("media fetcher on S3", () => {
  it("uses ranged GETs for range and one streamed GET for stream", async () => {
    const bucket = new FakeBucket();
    const s3 = new S3Storage({ endpoint: "https://r2.example", region: "auto", bucket: "media", accessKeyId: "AK", secretAccessKey: "SK", publicBaseUrl: "https://cdn.acme.test" }, bucket.fetch);
    const { m, owner } = await starsign(s3);
    const file = mp4(3 * MiB + 99);
    const row = await m.media.upload(owner, { bytes: file, filename: "clip.mp4" });
    const fetcher = m.media.fetcher();
    const media = m.media.toMedia(row);
    await expectReads(fetcher, media, file);
    // No ranged response was bigger than the chunk asked for.
    expect(bucket.maxServed).toBeLessThanOrEqual(MiB);
    const before = bucket.gets;
    await drain((await fetcher.stream!(media)).body);
    expect(bucket.gets - before).toBe(1);
  });

  it("keeps only the asked-for bytes when the server ignores Range", async () => {
    const bucket = new FakeBucket();
    bucket.ranges = false;
    const s3 = new S3Storage({ endpoint: "https://r2.example", region: "auto", bucket: "media", accessKeyId: "AK", secretAccessKey: "SK", publicBaseUrl: "https://cdn.acme.test" }, bucket.fetch);
    const file = pattern(2 * MiB);
    await s3.put("ws/k.mp4", file, "video/mp4");
    expectSame(await s3.getRange("ws/k.mp4", MiB + 5, 300), file.slice(MiB + 5, MiB + 305));
    const st = await s3.stream("ws/k.mp4");
    expect(st.size).toBe(2 * MiB);
    expectSame((await drain(st.body)).bytes, file);
    await expect(s3.stream("ws/none.mp4")).rejects.toThrow(/HTTP 404/);
  });
});

describe("media fetcher for external URLs", () => {
  const media: Media = { kind: "video", url: "https://cdn.other.example/clip.mp4", mime: "video/mp4" };

  it("uses HEAD for the size and Range GETs for reads when the server supports ranges", async () => {
    const { m } = await starsign(new LocalStorage(mkdtempSync(join(tmpdir(), "ss-")), "http://localhost:4000"));
    const file = pattern(3 * MiB + 1);
    const web = webServer(file, { ranges: true });
    const fetcher = m.media.fetcher(web.fetchImpl);
    await expectReads(fetcher, media, file);
    expect(web.stats.heads).toBeGreaterThan(0);
    expect(web.stats.rangeGets).toBeGreaterThan(0);
  });

  it("without Range support: size is unknown, range slices a full GET, and readers stream it once", async () => {
    const { m } = await starsign(new LocalStorage(mkdtempSync(join(tmpdir(), "ss-")), "http://localhost:4000"));
    const file = pattern(3 * MiB + 1);
    const web = webServer(file, { ranges: false });
    const fetcher = m.media.fetcher(web.fetchImpl);
    expect(await fetcher.size!(media)).toBeNull();
    expectSame(await fetcher.range!(media, 2 * MiB, 10), file.slice(2 * MiB, 2 * MiB + 10));
    const gets = web.stats.gets;
    const reader = await openMedia(fetcher, media);
    expect(reader.size).toBe(file.length);
    expect(reader.bytes).toBeNull(); // streamed, not buffered
    let at = 0;
    for await (const c of reader.chunks(MiB)) {
      expectSame(c, file.subarray(at, at + c.length));
      at += c.length;
    }
    await reader.close();
    expect(at).toBe(file.length);
    expect(web.stats.gets - gets).toBe(1); // one sequential download for the whole file
  });

  it("reports an HTTP error from the media URL", async () => {
    const { m } = await starsign(new LocalStorage(mkdtempSync(join(tmpdir(), "ss-")), "http://localhost:4000"));
    const fetcher = m.media.fetcher((async () => new Response("gone", { status: 404 })) as typeof fetch);
    expect(await fetcher.size!(media)).toBeNull();
    await expect(fetcher.stream!(media)).rejects.toThrow(/HTTP 404/);
    await expect(fetcher.range!(media, 0, 10)).rejects.toThrow(/HTTP 404/);
  });
});
