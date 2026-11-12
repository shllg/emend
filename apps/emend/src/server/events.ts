import { LIMITS, ReviewEvent, STREAM_PING_EVENT } from "@emend/contract";
import { ApiError } from "./http/errors.ts";

const ownedKey = (ownerId: string, id: string) => `${ownerId}\0${id}`;

type Listener = (event: ReviewEvent) => void;
type Waiting = {
  ownerId: string;
  active: number;
  revision: number;
  until: number;
  timer?: ReturnType<typeof setTimeout>;
};

export class ReviewEvents {
  private listeners = new Map<string, Map<string | null, Set<Listener>>>();
  private waiting = new Map<string, Waiting>();
  private streams = new Map<string, number>();
  private sessions = new Map<string, Set<() => void>>();
  private waitingByOwner = new Map<string, number>();
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
  }

  subscribe(ownerId: string, reviewId: string | null, listener: Listener) {
    let reviews = this.listeners.get(ownerId);
    if (!reviews) {
      reviews = new Map();
      this.listeners.set(ownerId, reviews);
    }
    let listeners = reviews.get(reviewId);
    if (!listeners) {
      listeners = new Set();
      reviews.set(reviewId, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (!listeners.size) reviews.delete(reviewId);
      if (!reviews.size) this.listeners.delete(ownerId);
    };
  }
  emit(ownerId: string, value: ReviewEvent) {
    // Strip any accidental content fields even when the caller isn't type checked.
    const event = ReviewEvent.parse(value);
    const waiting = this.waiting.get(ownedKey(ownerId, event.reviewId));
    if (waiting?.ownerId === ownerId && "revision" in event)
      waiting.revision = Math.max(waiting.revision, event.revision);
    const reviews = this.listeners.get(ownerId);
    for (const listener of [...(reviews?.get(null) ?? []), ...(reviews?.get(event.reviewId) ?? [])]) listener(event);
  }
  agentWaiting(ownerId: string, reviewId: string) {
    const state = this.waiting.get(ownedKey(ownerId, reviewId));
    if (!state) return false;
    if (state.active || state.until > this.now()) return true;
    clearTimeout(state.timer);
    this.waiting.delete(ownedKey(ownerId, reviewId));
    this.emit(state.ownerId, { type: "waiting", reviewId, revision: state.revision });
    return false;
  }
  beginWaiting(ownerId: string, reviewId: string, revision: number) {
    const count = this.waitingByOwner.get(ownerId) ?? 0;
    if (count >= LIMITS.waitingTakesPerOwner) throw new ApiError("rate_limited", "waiting_takes");
    this.waitingByOwner.set(ownerId, count + 1);
    const wasWaiting = this.agentWaiting(ownerId, reviewId);
    const state = this.waiting.get(ownedKey(ownerId, reviewId)) ?? { ownerId, active: 0, revision, until: 0 };
    clearTimeout(state.timer);
    state.active++;
    state.revision = Math.max(state.revision, revision);
    this.waiting.set(ownedKey(ownerId, reviewId), state);
    if (!wasWaiting) this.emit(ownerId, { type: "waiting", reviewId, revision: state.revision });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const remaining = (this.waitingByOwner.get(ownerId) ?? 1) - 1;
      if (remaining) this.waitingByOwner.set(ownerId, remaining);
      else this.waitingByOwner.delete(ownerId);
      state.active--;
      if (!state.active) {
        state.until = this.now() + 35000;
        const expire = () => {
          if (this.agentWaiting(ownerId, reviewId) && !state.active) {
            state.timer = setTimeout(expire, Math.max(1, state.until - this.now()));
            state.timer.unref();
          }
        };
        state.timer = setTimeout(expire, 35000);
        state.timer.unref();
      }
    };
  }
  waitForSend(ownerId: string, reviewId: string, seconds: number, signal?: AbortSignal) {
    let finish = () => {};
    const promise = new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe(ownerId, reviewId, (event) => {
        // A Send, or the reviewer ending the wait: snooze, retire, bin and delete.
        if (["send", "snooze", "retire", "delete", "bin"].includes(event.type)) finish();
      });
      const timer = setTimeout(() => finish(), seconds * 1000);
      finish = () => {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) finish();
    });
    return { promise, cancel: () => finish() };
  }
  closeSession(ownerId: string, tokenId: string) {
    for (const stop of [...(this.sessions.get(ownedKey(ownerId, tokenId)) ?? [])]) stop();
  }
  stream(
    ownerId: string,
    reviewId: string | null,
    tokenId: string,
    signal?: AbortSignal,
    isLive: () => Promise<boolean> = async () => true,
  ): ReadableStream<Uint8Array> {
    const count = this.streams.get(ownerId) ?? 0;
    if (count >= 32) throw new ApiError("rate_limited", "event_streams");
    this.streams.set(ownerId, count + 1);
    const encoder = new TextEncoder();
    let cleanup = () => {};
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          let closed = false;
          let ready = false;
          const unsubscribe = this.subscribe(ownerId, reviewId, (event) => {
            const { type, ...data } = event;
            if (!ready) return;
            enqueue(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
          });
          let checking = false;
          const keepalive = async () => {
            if (checking || closed || !ready) return;
            checking = true;
            try {
              if (await isLive()) enqueue(`event: ${STREAM_PING_EVENT}\ndata: {}\n\n`);
              else stop();
            } catch {
              stop();
            } finally {
              checking = false;
            }
          };
          const interval = setInterval(() => {
            void keepalive();
          }, 25000);
          interval.unref();
          const stop = () => {
            if (!closed) {
              cleanup();
              controller.close();
            }
          };
          const sessionKey = ownedKey(ownerId, tokenId);
          let stops = this.sessions.get(sessionKey);
          if (!stops) {
            stops = new Set();
            this.sessions.set(sessionKey, stops);
          }
          stops.add(stop);
          cleanup = () => {
            if (closed) return;
            closed = true;
            unsubscribe();
            stops.delete(stop);
            if (!stops.size) this.sessions.delete(sessionKey);
            clearInterval(interval);
            signal?.removeEventListener("abort", stop);
            const remaining = (this.streams.get(ownerId) ?? 1) - 1;
            if (remaining) this.streams.set(ownerId, remaining);
            else this.streams.delete(ownerId);
          };
          const enqueue = (text: string) => {
            if (closed) return;
            if ((controller.desiredSize ?? 0) <= 0) {
              cleanup();
              controller.error(new Error("Event stream is too slow"));
            } else controller.enqueue(encoder.encode(text));
          };
          signal?.addEventListener("abort", stop, { once: true });
          if (signal?.aborted) stop();
          else
            void isLive()
              .then((live) => {
                if (closed) return;
                if (!live) stop();
                else {
                  ready = true;
                  enqueue(": connected\n\n");
                }
              })
              .catch(stop);
        },
        cancel: () => cleanup(),
      },
      { highWaterMark: 100, size: () => 1 },
    );
  }
}
