import { ReviewEvent, ReviewEventName, STREAM_PING_EVENT, STREAM_SILENCE_MS } from "@recense/contract";
import { ApiError, head } from "../api/client.ts";

type Notice = { kind: "open" } | { kind: "ping" } | { kind: "event"; type: string; data: string };

/** A valid notice is a frame: it proves the leader's stream is alive. */
function parseNotice(value: unknown): ReviewEvent | "open" | "ping" | null {
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  if ((value.kind === "open" || value.kind === "ping") && Object.keys(value).length === 1) return value.kind;
  if (value.kind !== "event" || !("type" in value) || !("data" in value) || typeof value.data !== "string") return null;
  try {
    return ReviewEvent.parse({ ...JSON.parse(value.data), type: value.type });
  } catch {
    return null;
  }
}

/** A tab hidden longer than this has probably been suspended, so its socket cannot be trusted. */
const HIDDEN_MS = 5_000;
/** Signals that arrive together (online, pageshow, visible) cause one reconnect. */
const DUPLICATE_MS = 1_000;
/** A visible follower checks this often whether the leader has gone quiet. */
const FOLLOWER_CHECK_MS = 10_000;
/** Refresh in a follower steals the stream only when the leader has been quiet this long. */
const REFRESH_STEAL_MS = 30_000;

/** `reconnect` returns whether it started a new connection. */
type Source = { stop: () => void; reconnect: () => boolean };

function openSource(post: (notice: Notice) => void): Source {
  let source: EventSource | undefined;
  let stopped = false;
  let delay = 1000;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let probe: AbortController | undefined;
  let resumeAfterProbe = false;
  let connectedAt = 0;
  let hiddenAt: number | undefined;
  const schedule = () => {
    if (stopped || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, delay);
    delay = Math.min(delay * 2, 60_000);
  };
  // After an iOS suspend the socket is dead but still reports open, and a comment line fires no
  // browser event. The server sends a `ping` event every 25 s, so a long silence means a dead stream.
  const touch = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => reconnect(true), STREAM_SILENCE_MS);
  };
  const checkClosed = async (current: EventSource) => {
    if (stopped || source !== current || probe || retry !== undefined) return;
    const mine = new AbortController();
    probe = mine;
    try {
      // EventSource hides HTTP errors. HEAD checks authorization without allocating a stream.
      await head("/api/v1/events", mine.signal);
    } catch (error) {
      if (!mine.signal.aborted && error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        stopped = true;
        current.close();
      }
    } finally {
      if (probe === mine) probe = undefined;
      // An aborted probe was replaced by an immediate reconnect, which owns what happens next.
      if (!stopped && source === current && !mine.signal.aborted) {
        if (resumeAfterProbe) {
          resumeAfterProbe = false;
          connect();
        } else schedule();
      }
    }
  };
  const connect = () => {
    if (stopped) return;
    clearTimeout(watchdog);
    source?.close();
    connectedAt = Date.now();
    let current: EventSource;
    try {
      current = new EventSource("/api/v1/events");
    } catch {
      source = undefined;
      schedule();
      return;
    }
    source = current;
    current.addEventListener("error", () => {
      if (current.readyState === EventSource.CLOSED) {
        clearTimeout(watchdog);
        void checkClosed(current);
      }
    });
    current.addEventListener("open", () => {
      if (stopped || source !== current) return;
      clearTimeout(retry);
      retry = undefined;
      delay = 1000;
      touch();
      post({ kind: "open" });
    });
    current.addEventListener(STREAM_PING_EVENT, () => {
      if (stopped || source !== current) return;
      touch();
      post({ kind: "ping" });
    });
    for (const type of ReviewEventName.options) {
      current.addEventListener(type, (event: MessageEvent<string>) => {
        if (stopped || source !== current) return;
        touch();
        post({ kind: "event", type, data: event.data });
      });
    }
  };
  /** Replaces a stream that may look open but be dead. `immediate` skips the duplicate guard. */
  const reconnect = (immediate = false) => {
    if (stopped) return;
    if (!immediate && Date.now() - connectedAt < DUPLICATE_MS) return;
    if (probe) {
      if (!immediate) {
        resumeAfterProbe = true;
        return;
      }
      // Connect at once; the abandoned probe must neither schedule nor connect again.
      probe.abort();
      probe = undefined;
      resumeAfterProbe = false;
    }
    clearTimeout(retry);
    retry = undefined;
    connect();
  };
  const resume = () => {
    if (stopped) return;
    if (source && source.readyState !== EventSource.CLOSED) return;
    if (probe) {
      resumeAfterProbe = true;
      return;
    }
    clearTimeout(retry);
    retry = undefined;
    connect();
  };
  const recover = () => {
    if (source && source.readyState !== EventSource.CLOSED) reconnect();
    else resume();
  };
  const visible = () => {
    if (document.visibilityState !== "visible") {
      hiddenAt ??= Date.now();
      return;
    }
    const away = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
    hiddenAt = undefined;
    if (away > HIDDEN_MS) recover();
    else resume();
  };
  window.addEventListener("online", recover);
  window.addEventListener("pageshow", recover);
  document.addEventListener("visibilitychange", visible);
  connect();
  return {
    // Refresh starts from the base delay again. The watchdog keeps its backoff.
    reconnect: () => {
      if (stopped) return false;
      delay = 1000;
      reconnect(true);
      return true;
    },
    stop: () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(watchdog);
      probe?.abort();
      source?.close();
      window.removeEventListener("online", recover);
      window.removeEventListener("pageshow", recover);
      document.removeEventListener("visibilitychange", visible);
    },
  };
}

/** Reconnect the stream of this tab's subscription; false when it started nothing. */
let reconnectCurrent: (() => boolean) | undefined;
const openWaiters = new Set<() => void>();

/**
 * Replace the live stream now, for the Refresh control. Resolves true when the new stream opened
 * within `timeoutMs`, which makes the open refresh (see `ReviewEventsProvider`) refetch the cached
 * queries in every tab. Resolves false when nothing was reconnected or the stream did not open
 * (offline, failing), and the caller then refetches by itself.
 */
export function reconnectReviewEvents(timeoutMs = 3_000): Promise<boolean> {
  const start = reconnectCurrent;
  if (!start) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const finish = (opened: boolean) => {
      clearTimeout(timer);
      openWaiters.delete(waiter);
      resolve(opened);
    };
    const waiter = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    openWaiters.add(waiter);
    if (!start()) finish(false);
  });
}

/**
 * One connection per origin where Web Locks and BroadcastChannel are available.
 *
 * The tab holding the "recense-events" lock is the leader: it owns the EventSource and relays every
 * frame (pings included) over the channel. A suspended leader cannot say so. A visible follower
 * that sees no relayed frame for 40 s therefore steals the lock and opens its own stream. The old
 * leader's lock request then rejects, so it closes its stream and queues for the lock again.
 */
export function subscribeReviewEvents(onEvent: (event: ReviewEvent) => void, onOpen: () => void) {
  let stopped = false;
  let lastFrame = Date.now();
  const receive = (value: unknown) => {
    if (stopped) return;
    const notice = parseNotice(value);
    if (notice === "open") {
      onOpen();
      for (const waiter of [...openWaiters]) waiter();
    } else if (notice && notice !== "ping") onEvent(notice);
  };
  if (!navigator.locks?.request || typeof BroadcastChannel === "undefined") {
    const direct = openSource(receive);
    reconnectCurrent = direct.reconnect;
    return () => {
      if (reconnectCurrent === direct.reconnect) reconnectCurrent = undefined;
      direct.stop();
    };
  }
  const channel = new BroadcastChannel("recense-events");
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (parseNotice(event.data)) lastFrame = Date.now();
    receive(event.data);
  });
  // Every lock request owns its controller and its source, so a late callback or catch can only
  // touch what it started. `queued` is the one waiting (non-steal) request; `stealing` is a steal
  // from this tab that has not been granted yet.
  const requests = new Map<AbortController, () => void>();
  let leader: Source | undefined;
  let queued: AbortController | undefined;
  let stealing = false;
  const acquire = (steal: boolean) => {
    if (stopped) return;
    if (steal) {
      if (stealing || leader) return;
      stealing = true;
    } else queued?.abort();
    const request = new AbortController();
    let held = false;
    let mine: Source | undefined;
    let release = () => {};
    const lifetime = new Promise<void>((resolve) => {
      release = resolve;
    });
    requests.set(request, release);
    if (!steal) queued = request;
    // The Web Locks API does not allow `steal` together with `signal`.
    const options = steal ? { steal: true } : { signal: request.signal };
    navigator.locks
      .request("recense-events", options, async () => {
        if (stopped || request.signal.aborted) return;
        held = true;
        if (steal) {
          stealing = false;
          // This tab leads now, so its own waiting request is superseded.
          queued?.abort();
        }
        if (queued === request || steal) queued = undefined;
        lastFrame = Date.now();
        mine = openSource((notice) => {
          lastFrame = Date.now();
          receive(notice);
          channel.postMessage(notice);
        });
        leader = mine;
        await lifetime;
      })
      .catch(() => {
        if (steal) stealing = false;
        if (stopped || request.signal.aborted) return;
        if (held) {
          // Stolen: another tab leads now. Close this request's stream and wait for the lock
          // again, starting the silence clock now so this tab does not steal straight back.
          mine?.stop();
          if (leader === mine) leader = undefined;
          lastFrame = Date.now();
          acquire(false);
        } else if (!steal) {
          // A denied lock must not leave an otherwise usable browser silently stale.
          mine = openSource(receive);
          leader = mine;
        }
      })
      .finally(() => {
        requests.delete(request);
        release();
      });
  };
  acquire(false);
  /** The leader reconnects; a follower steals only when the leader has been quiet for a while. */
  const reconnect = () => {
    if (stopped) return false;
    if (leader) return leader.reconnect();
    if (stealing) return true;
    if (Date.now() - lastFrame <= REFRESH_STEAL_MS) return false;
    acquire(true);
    return true;
  };
  reconnectCurrent = reconnect;
  const check = setInterval(() => {
    if (leader || stopped || document.visibilityState !== "visible") return;
    if (Date.now() - lastFrame <= STREAM_SILENCE_MS) return;
    lastFrame = Date.now();
    acquire(true);
  }, FOLLOWER_CHECK_MS);
  // A tab that was asleep has seen no frames; give the leader one ping interval before judging it.
  const onVisible = () => {
    if (document.visibilityState === "visible") lastFrame = Date.now();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    clearInterval(check);
    document.removeEventListener("visibilitychange", onVisible);
    if (reconnectCurrent === reconnect) reconnectCurrent = undefined;
    leader?.stop();
    channel.close();
    for (const [request, release] of requests) {
      request.abort();
      release();
    }
  };
}
