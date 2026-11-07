import { createHash, createHmac } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { emptyStream, sliceStream } from "./streams.ts";

/** Where uploaded files live. Keys are unguessable; URLs are public so networks that pull media can fetch them. */
export interface MediaStorage {
  readonly name: string;
  put(key: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  publicUrl(key: string): string;
  /** Direct uploads: a URL the browser PUTs the file to, so large files never pass through the API. */
  presignPut?(key: string, mime: string, expiresSeconds: number): { url: string; headers: Record<string, string> };
  /** Size and type of a stored object, or null when it does not exist. */
  head?(key: string): Promise<{ bytes: number; mime: string | null; etag: string | null } | null>;
  /** Bytes [start, start + length) of a stored object. */
  getRange?(key: string, start: number, length: number): Promise<Uint8Array>;
  /** The whole object as a stream, read as it is consumed (connectors upload large videos from this). */
  stream?(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number | null }>;
}

/** Piece size for streaming files off local disk. */
const LOCAL_PIECE_BYTES = 1024 * 1024;

/** Local disk, served by the API at /media/:key. Fine for one machine and for development. */
export class LocalStorage implements MediaStorage {
  readonly name = "local";
  private readonly root: string;
  constructor(
    root: string,
    private readonly baseUrl: string,
  ) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes("..")) throw new Error("bad media key");
    return join(this.root, key);
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, bytes);
  }
  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.path(key)));
  }
  async head(key: string): Promise<{ bytes: number; mime: string | null; etag: string | null } | null> {
    const st = await stat(this.path(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    return st ? { bytes: st.size, mime: null, etag: null } : null;
  }
  /** A positional read: only `length` bytes are read from disk. */
  async getRange(key: string, start: number, length: number): Promise<Uint8Array> {
    const fh = await open(this.path(key), "r");
    try {
      const out = new Uint8Array(Math.max(0, length));
      let filled = 0;
      while (filled < out.length) {
        const { bytesRead } = await fh.read(out, filled, out.length - filled, start + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return out.subarray(0, filled);
    } finally {
      await fh.close();
    }
  }
  /** The file in 1 MB pieces, pulled as the consumer reads; the handle closes at the end or on cancel. */
  async stream(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number | null }> {
    const fh = await open(this.path(key), "r");
    const size = (await fh.stat()).size;
    if (size === 0) {
      await fh.close();
      return { body: emptyStream(), size: 0 };
    }
    let pos = 0;
    let closed = false;
    const done = async () => {
      if (closed) return;
      closed = true;
      await fh.close().catch(() => undefined);
    };
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          try {
            const buf = new Uint8Array(Math.min(LOCAL_PIECE_BYTES, size - pos));
            const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
            pos += bytesRead;
            if (bytesRead > 0) c.enqueue(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
            if (bytesRead === 0 || pos >= size) {
              await done();
              c.close();
            }
          } catch (err) {
            await done();
            c.error(err);
          }
        },
        cancel: done,
      },
      { highWaterMark: 0 },
    );
    return { body, size };
  }
  async delete(key: string): Promise<void> {
    await unlink(this.path(key)).catch(() => {});
  }
  publicUrl(key: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}/media/${key}`;
  }
}

export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com or https://s3.us-west-2.amazonaws.com */
  endpoint: string;
  /** "auto" for R2 */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public base URL objects are served from (R2 public bucket / custom domain / CloudFront). */
  publicBaseUrl: string;
}

/**
 * Any S3-compatible store (AWS S3, Cloudflare R2, MinIO, Backblaze B2) with path-style requests signed by
 * AWS Signature V4. No SDK: a handful of verbs are all Starsign needs.
 */
export class S3Storage implements MediaStorage {
  readonly name = "s3";
  constructor(
    private readonly cfg: S3Config,
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
    private readonly now: () => Date = () => new Date(),
  ) {}

  url(key: string): URL {
    return new URL(`${this.cfg.endpoint.replace(/\/+$/, "")}/${this.cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`);
  }

  /** AWS SigV4 headers for a request. */
  sign(method: string, url: URL, payload: Uint8Array, extra: Record<string, string> = {}): Record<string, string> {
    const t = this.now();
    const amzDate = t.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    const payloadHash = createHash("sha256").update(payload).digest("hex");
    const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, ...lower(extra) };
    const names = Object.keys(headers).sort();
    const canonical = [method, url.pathname, url.searchParams.toString(), names.map((n) => `${n}:${String(headers[n]).trim()}\n`).join(""), names.join(";"), payloadHash].join("\n");
    const scope = `${day}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, day), this.cfg.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    const { host: _host, ...rest } = headers;
    return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
  }

  /**
   * A query-string-signed URL (SigV4 presigning). The payload is unsigned, as S3 requires for presigned uploads; every
   * header in `headers` is signed, so the uploader must send exactly those.
   */
  presign(method: string, url: URL, expiresSeconds: number, headers: Record<string, string> = {}): URL {
    const t = this.now();
    const amzDate = t.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const day = amzDate.slice(0, 8);
    const scope = `${day}/${this.cfg.region}/s3/aws4_request`;
    const signed: Record<string, string> = { host: url.host, ...lower(headers) };
    const names = Object.keys(signed).sort();
    const query: Record<string, string> = {
      ...Object.fromEntries(url.searchParams),
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.cfg.accessKeyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(Math.max(1, Math.min(604800, Math.floor(expiresSeconds)))),
      "X-Amz-SignedHeaders": names.join(";"),
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${rfc3986(k)}=${rfc3986(query[k]!)}`)
      .join("&");
    const canonical = [method, url.pathname, canonicalQuery, names.map((n) => `${n}:${String(signed[n]).trim()}\n`).join(""), names.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
    const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
    const kSigning = hmac(hmac(hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, day), this.cfg.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(toSign).digest("hex");
    const out = new URL(url.toString());
    out.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
    return out;
  }

  presignPut(key: string, mime: string, expiresSeconds: number): { url: string; headers: Record<string, string> } {
    const headers = { "content-type": mime };
    return { url: this.presign("PUT", this.url(key), expiresSeconds, headers).toString(), headers };
  }

  async head(key: string): Promise<{ bytes: number; mime: string | null; etag: string | null } | null> {
    const url = this.url(key);
    const res = await this.fetchImpl(url, { method: "HEAD", headers: this.sign("HEAD", url, new Uint8Array()) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`s3 head ${key}: HTTP ${res.status}`);
    return { bytes: Number(res.headers.get("content-length") ?? 0), mime: res.headers.get("content-type"), etag: res.headers.get("etag")?.replace(/"/g, "") ?? null };
  }

  async getRange(key: string, start: number, length: number): Promise<Uint8Array> {
    const url = this.url(key);
    const range = `bytes=${start}-${start + Math.max(1, length) - 1}`;
    const res = await this.fetchImpl(url, { method: "GET", headers: this.sign("GET", url, new Uint8Array(), { Range: range }) });
    if (res.status === 416) return new Uint8Array();
    if (!res.ok) throw new Error(`s3 range ${key}: HTTP ${res.status}`);
    // A server that ignores Range sends the whole object: read past `start` and keep only what was asked for,
    // without holding the rest.
    if (res.status === 200) return sliceStream(res.body, start, length);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** One GET whose body is handed over unread. */
  async stream(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number | null }> {
    const url = this.url(key);
    const res = await this.fetchImpl(url, { method: "GET", headers: this.sign("GET", url, new Uint8Array()) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`s3 get ${key}: HTTP ${res.status}`);
    }
    const len = res.headers.get("content-length");
    return { body: res.body ?? emptyStream(), size: len !== null && /^\d+$/.test(len) ? Number(len) : null };
  }

  async put(key: string, bytes: Uint8Array, mime: string): Promise<void> {
    const url = this.url(key);
    const res = await this.fetchImpl(url, { method: "PUT", headers: this.sign("PUT", url, bytes, { "content-type": mime }), body: bytes });
    if (!res.ok) throw new Error(`s3 put ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  async get(key: string): Promise<Uint8Array> {
    const url = this.url(key);
    const res = await this.fetchImpl(url, { method: "GET", headers: this.sign("GET", url, new Uint8Array()) });
    if (!res.ok) throw new Error(`s3 get ${key}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async delete(key: string): Promise<void> {
    const url = this.url(key);
    await this.fetchImpl(url, { method: "DELETE", headers: this.sign("DELETE", url, new Uint8Array()) });
  }
  publicUrl(key: string): string {
    return `${this.cfg.publicBaseUrl.replace(/\/+$/, "")}/${key}`;
  }
}

/** S3's URI encoding: everything but unreserved characters. */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}

/** STARSIGN_S3_* selects S3; otherwise local disk under STARSIGN_MEDIA_DIR served from STARSIGN_PUBLIC_URL. */
export function storageFromEnv(env: NodeJS.ProcessEnv = process.env): MediaStorage {
  if (env.STARSIGN_S3_BUCKET && env.STARSIGN_S3_ACCESS_KEY_ID && env.STARSIGN_S3_SECRET_ACCESS_KEY && env.STARSIGN_S3_ENDPOINT && env.STARSIGN_S3_PUBLIC_URL) {
    return new S3Storage({
      endpoint: env.STARSIGN_S3_ENDPOINT,
      region: env.STARSIGN_S3_REGION ?? "auto",
      bucket: env.STARSIGN_S3_BUCKET,
      accessKeyId: env.STARSIGN_S3_ACCESS_KEY_ID,
      secretAccessKey: env.STARSIGN_S3_SECRET_ACCESS_KEY,
      publicBaseUrl: env.STARSIGN_S3_PUBLIC_URL,
    });
  }
  return new LocalStorage(env.STARSIGN_MEDIA_DIR ?? ".media", env.STARSIGN_PUBLIC_URL ?? `http://localhost:${env.PORT ?? 4000}`);
}
