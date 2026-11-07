import { describe, expect, it } from "vitest";
import type { Media } from "@starsign/schema";
import { STREAM_PIECE_BYTES, StreamingForm, openMedia, readChunks, streamInit, withMedia, type MediaFetcher } from "../src/index.ts";
import { probeMp4, probeMp4Ranged } from "../src/youtube.ts";
import { MiB, bigVideo, byteAt } from "./big-video.ts";

const VIDEO: Media = { kind: "video", url: "https://media.example/v.mp4", mime: "video/mp4" };

async function all(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const c of gen) out.push(c);
  return out;
}
const join = (parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
async function text(s: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(s).text();
}

/** A fetcher with only a stream (no Range support), counting how often the download is opened. */
function streamOnly(bytes: Uint8Array, size: number | null = bytes.length, piece = 7) {
  const stats = { opens: 0, cancels: 0 };
  const fetcher: MediaFetcher = {
    fetch: async () => {
      throw new Error("not expected");
    },
    stream: async () => {
      stats.opens++;
      let pos = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (pos >= bytes.length) return c.close();
          c.enqueue(bytes.slice(pos, pos + piece));
          pos += piece;
        },
        cancel() {
          stats.cancels++;
        },
      });
      return { body, size, mime: "video/mp4" };
    },
  };
  return { fetcher, stats };
}

describe("readChunks", () => {
  it("yields chunkSize chunks via range, never more than one chunk per read, and never calls fetch", async () => {
    const { fetcher, stats } = bigVideo(10 * MiB + 5, { stream: false });
    const sizes: number[] = [];
    let offset = 0;
    for await (const c of readChunks(fetcher, VIDEO, 3 * MiB)) {
      expect(c[0]).toBe(byteAt(offset));
      expect(c[c.length - 1]).toBe(byteAt(offset + c.length - 1));
      offset += c.length;
      sizes.push(c.length);
    }
    expect(sizes).toEqual([3 * MiB, 3 * MiB, 3 * MiB, MiB + 5]);
    expect(stats.maxRead).toBe(3 * MiB);
    expect(stats.fetchCalls).toBe(0);
  });

  it("falls back to slicing fetch for fetchers without ranges", async () => {
    let fetches = 0;
    const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
    const fetcher: MediaFetcher = { fetch: async () => (fetches++, { bytes, mime: "video/mp4" }) };
    expect((await all(readChunks(fetcher, VIDEO, 4))).map((c) => [...c])).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);
    expect(fetches).toBe(1);
    const r = await openMedia(fetcher, VIDEO);
    expect(r.bytes).toBe(bytes);
    expect(r.size).toBe(10);
  });

  it("falls back to fetch when size() says it cannot know", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const fetcher: MediaFetcher = { fetch: async () => ({ bytes, mime: "video/mp4" }), size: async () => null, range: async () => new Uint8Array() };
    expect((await all(readChunks(fetcher, VIDEO, 2))).map((c) => [...c])).toEqual([[1, 2], [3]]);
  });

  it("rejects a short range read instead of uploading a truncated file", async () => {
    const fetcher: MediaFetcher = { fetch: async () => ({ bytes: new Uint8Array(), mime: "" }), size: async () => 100, range: async (_m, _s, n) => new Uint8Array(n - 1) };
    await expect(all(readChunks(fetcher, VIDEO, 40))).rejects.toMatchObject({ kind: "network", retryable: true });
  });

  it("re-chunks a stream-only source sequentially, reopening it only when a read goes backwards", async () => {
    const bytes = Uint8Array.from({ length: 50 }, (_, i) => i);
    const { fetcher, stats } = streamOnly(bytes);
    const r = await openMedia(fetcher, VIDEO);
    expect(r.size).toBe(50);
    expect(r.bytes).toBeNull();
    expect(join(await all(r.chunks(16)))).toEqual(bytes);
    expect(stats.opens).toBe(1);
    expect([...(await r.read(10, 3))]).toEqual([10, 11, 12]); // backwards: a new download
    expect([...(await r.read(40, 2))]).toEqual([40, 41]); // forwards: same download, skipping ahead
    expect(stats.opens).toBe(2);
    await r.close();
    expect(stats.cancels).toBe(1); // the open download is cancelled; the first had already ended
  });

  it("reads a stream of unknown length whole (protocols need the size up front)", async () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => i);
    const { fetcher } = streamOnly(bytes, null);
    const r = await openMedia(fetcher, VIDEO);
    expect(r.bytes).toEqual(bytes);
  });
});

describe("streamed bodies", () => {
  it("a full-file body uses the fetcher's stream; a partial one ranged pieces", async () => {
    const { fetcher, stats } = bigVideo(9 * MiB);
    await withMedia(fetcher, VIDEO, async (r) => {
      const whole = r.body();
      expect(whole.length).toBe(9 * MiB);
      expect((await new Response(whole.open()).arrayBuffer()).byteLength).toBe(9 * MiB);
      expect(stats.maxRead).toBe(MiB); // the fake stream's pieces
      const part = r.body(MiB, 5 * MiB);
      const got = new Uint8Array(await new Response(part.open()).arrayBuffer());
      expect(got.length).toBe(5 * MiB);
      expect(got[0]).toBe(byteAt(MiB));
      expect(stats.maxRead).toBe(STREAM_PIECE_BYTES);
    });
  });

  it("streamInit sets an exact Content-Length and duplex half", () => {
    const s = streamInit({ length: 12, type: "video/mp4", open: () => new ReadableStream() }, { authorization: "Bearer x" });
    expect(s.headers).toEqual({ "content-type": "video/mp4", authorization: "Bearer x", "content-length": "12" });
    expect(s.duplex).toBe("half");
  });
});

describe("StreamingForm", () => {
  it("produces multipart that parses like FormData, with the exact length it announces", async () => {
    const { fetcher } = bigVideo(100_000);
    const r = await openMedia(fetcher, VIDEO);
    const form = new StreamingForm();
    form.set("payload_json", '{"content":"line one\nline two"}');
    form.set("title", "first");
    form.setFile("files[0]", r.body(), 'clip "one".mp4');
    form.set("json", new Blob(['{"a":1}'], { type: "application/json" }));
    form.set("title", "replaced"); // FormData.set semantics: replace in place
    const raw = new Uint8Array(await new Response(form.open()).arrayBuffer());
    expect(raw.length).toBe(form.length);
    const parsed = await new Response(raw, { headers: { "content-type": form.type } }).formData();
    expect([...parsed.keys()]).toEqual(["payload_json", "title", "files[0]", "json"]);
    expect(parsed.get("title")).toBe("replaced");
    expect(parsed.get("payload_json")).toBe('{"content":"line one\r\nline two"}');
    const file = parsed.get("files[0]") as File;
    expect(file.name).toBe('clip "one".mp4'); // escaped as %22 on the wire, as FormData does
    expect(file.type).toBe("video/mp4");
    expect(file.size).toBe(100_000);
    const fb = new Uint8Array(await file.arrayBuffer());
    expect(fb[99_999]).toBe(byteAt(99_999));
    const json = parsed.get("json") as File;
    expect(json.name).toBe("blob");
    expect(await json.text()).toBe('{"a":1}');
  });

  it("errors the body when a file stream is shorter than announced", async () => {
    const form = new StreamingForm();
    form.setFile("f", { length: 10, type: "video/mp4", open: () => new Blob([new Uint8Array(4)]).stream() as ReadableStream<Uint8Array> }, "f.mp4");
    await expect(text(form.open())).rejects.toThrow(/got 4 of 10 bytes/);
  });
});

describe("probeMp4Ranged", () => {
  it("finds a moov box after a large mdat with a few header reads", async () => {
    const box = (type: string, body: Uint8Array) => {
      const out = new Uint8Array(8 + body.length);
      new DataView(out.buffer).setUint32(0, out.length);
      out.set(Buffer.from(type), 4);
      out.set(body, 8);
      return out;
    };
    const mvhd = new Uint8Array(100);
    new DataView(mvhd.buffer).setUint32(12, 1000);
    new DataView(mvhd.buffer).setUint32(16, 42_000);
    const file = join([box("ftyp", Uint8Array.from([...Buffer.from("isom"), 0, 0, 0, 0])), box("mdat", new Uint8Array(3 * MiB)), box("moov", box("mvhd", mvhd))]);
    let maxRead = 0;
    const fetcher: MediaFetcher = {
      fetch: async () => {
        throw new Error("not expected");
      },
      size: async () => file.length,
      range: async (_m, s, n) => ((maxRead = Math.max(maxRead, n)), file.slice(s, s + n)),
    };
    const r = await openMedia(fetcher, VIDEO);
    expect(await probeMp4Ranged(r)).toEqual(probeMp4(file));
    expect((await probeMp4Ranged(r)).durationSeconds).toBe(42);
    expect(maxRead).toBeLessThan(1024);
  });
});
