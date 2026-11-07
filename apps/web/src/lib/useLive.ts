import { useEffect, useState } from "react";
import { openFeedStream } from "../api";
import type { FeedEvent, LiveStatus } from "../types";

export interface LiveCounters {
  activity: number;
  post: number;
  alert: number;
  forecast: number;
  /** inbox workflow */
  inbox: number;
}

const ZERO: LiveCounters = { activity: 0, post: 0, alert: 0, forecast: 0, inbox: 0 };

/**
 * Keeps one SSE connection open while the room is on screen. Panels depend on the counter for the
 * event kind they care about and refetch when it moves, so the room refreshes itself live.
 */
export function useLive(enabled: boolean): { counters: LiveCounters; status: LiveStatus; last: FeedEvent | null } {
  const [counters, setCounters] = useState<LiveCounters>(ZERO);
  const [status, setStatus] = useState<LiveStatus>("off");
  const [last, setLast] = useState<FeedEvent | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      return;
    }
    const close = openFeedStream({
      onEvent: (e) => {
        setLast(e);
        setCounters((c) => {
          const next = { ...c };
          next[e.type] += 1;
          return next;
        });
      },
      onStatus: setStatus,
    });
    return close;
  }, [enabled]);

  return { counters, status, last };
}
