import { addDays, wallParts, wallToMs } from "./tz";

// The Analytics view's period and filters: presets (7 / 30 / 90 days) or a custom range of whole local days,
// remembered per browser like the tracker's period.

export type AnalyticsPreset = "7d" | "30d" | "90d" | "custom";

export interface AnalyticsChoice {
  preset: AnalyticsPreset;
  /** YYYY-MM-DD, workspace time, used when preset is "custom". */
  customFrom: string;
  customTo: string;
  network: string;
  account: string;
}

export const PRESETS: { id: AnalyticsPreset; label: string; days: number; long: string }[] = [
  { id: "7d", label: "7 days", days: 7, long: "previous 7 days" },
  { id: "30d", label: "30 days", days: 30, long: "previous 30 days" },
  { id: "90d", label: "90 days", days: 90, long: "previous 90 days" },
  { id: "custom", label: "Custom", days: 0, long: "previous period" },
];

const STORAGE = "starsign.analytics";

const ymd = (ms: number, tz: string) => {
  const w = wallParts(ms, tz);
  return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;
};

export function defaultChoice(tz: string, now = Date.now()): AnalyticsChoice {
  return { preset: "30d", customFrom: ymd(addDays(now, -13, tz), tz), customTo: ymd(now, tz), network: "", account: "" };
}

export function readChoice(tz: string): AnalyticsChoice {
  const d = defaultChoice(tz);
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE) ?? "null") as Partial<AnalyticsChoice> | null;
    if (!raw) return d;
    const preset = PRESETS.some((p) => p.id === raw.preset) ? (raw.preset as AnalyticsPreset) : d.preset;
    const okDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    return {
      preset,
      customFrom: okDay(raw.customFrom) ? raw.customFrom : d.customFrom,
      customTo: okDay(raw.customTo) ? raw.customTo : d.customTo,
      network: typeof raw.network === "string" ? raw.network : "",
      account: typeof raw.account === "string" ? raw.account : "",
    };
  } catch {
    return d;
  }
}

export function rememberChoice(c: AnalyticsChoice): void {
  try {
    localStorage.setItem(STORAGE, JSON.stringify(c));
  } catch {
    // fine: lasts for this page load
  }
}

/** The instants a choice covers. A preset ends now; a custom range runs from the start of its first day to the end of its last. */
export function windowOf(c: AnalyticsChoice, tz: string, now = Date.now()): { from: string; to: string; label: string } {
  if (c.preset !== "custom") {
    const days = PRESETS.find((p) => p.id === c.preset)?.days ?? 30;
    return { from: new Date(now - days * 86_400_000).toISOString(), to: new Date(now).toISOString(), label: `Last ${days} days` };
  }
  const [a, b] = c.customFrom <= c.customTo ? [c.customFrom, c.customTo] : [c.customTo, c.customFrom];
  const [ay, am, ad] = a.split("-").map(Number) as [number, number, number];
  const [by, bm, bd] = b.split("-").map(Number) as [number, number, number];
  const from = wallToMs(ay, am, ad, 0, 0, tz);
  const end = Math.min(now, addDays(wallToMs(by, bm, bd, 0, 0, tz), 1, tz) - 1);
  return { from: new Date(from).toISOString(), to: new Date(Math.max(end, from + 3_600_000)).toISOString(), label: "Custom range" };
}
