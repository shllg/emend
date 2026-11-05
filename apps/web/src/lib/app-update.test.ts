import { expect, test, vi } from "vitest";
import {
  type AppUpdateDeps,
  buildTag,
  createAppUpdate,
  INSTALL_TIMEOUT_MS,
  RETURN_CHECK_INTERVAL_MS,
  SETTLE_TIMEOUT_MS,
} from "./app-update.ts";

class FakeWorker extends EventTarget {
  state = "installing";
  postMessage = vi.fn();
  become(state: string) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}
class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null;
  installing: FakeWorker | null = null;
  update = vi.fn(async (): Promise<unknown> => undefined);
}
class FakeContainer extends EventTarget {
  controller: object | null;
  registration = new FakeRegistration();
  register = vi.fn(async (_url: string) => this.registration);
  constructor(controlled: boolean) {
    super();
    this.controller = controlled ? {} : null;
  }
  controllerChange() {
    this.dispatchEvent(new Event("controllerchange"));
  }
}
class FakeDocument extends EventTarget {
  visibilityState = "visible";
}
type FakeTimer = { callback: () => void; ms: number; cleared: boolean };
function makeDeps(parts: {
  container: FakeContainer | undefined;
  document: FakeDocument;
  page: EventTarget;
  reload: () => void;
  time: { now: number };
  timers: FakeTimer[];
  production?: boolean;
}): AppUpdateDeps {
  return {
    production: parts.production ?? true,
    serviceWorker: parts.container as unknown as AppUpdateDeps["serviceWorker"],
    reload: parts.reload,
    now: () => parts.time.now,
    setTimeout: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      parts.timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as FakeTimer).cleared = true;
    },
    document: parts.document as unknown as AppUpdateDeps["document"],
    window: parts.page as unknown as AppUpdateDeps["window"],
  };
}
function setup({ controlled = true, production = true, clock = 1_000_000 } = {}) {
  const container = new FakeContainer(controlled);
  const document = new FakeDocument();
  const page = new EventTarget();
  const reload = vi.fn();
  const time = { now: clock };
  const timers: FakeTimer[] = [];
  const parts = { container, document, page, reload, time, timers, production };
  const store = createAppUpdate(() => makeDeps(parts));
  const states: string[] = [];
  store.subscribe(() => states.push(store.getSnapshot().state));
  return {
    store,
    container,
    registration: container.registration,
    document,
    page,
    reload,
    time,
    states,
    timers,
    parts,
    /** Run the pending timers, as if their time had come. */
    fireTimers() {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
    },
    async started() {
      store.start();
      await container.register.mock.results[0]?.value;
      expect(container.registration.update).toHaveBeenCalled();
      await container.registration.update.mock.results[0]?.value.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}
function pageshow(persisted: boolean) {
  return Object.assign(new Event("pageshow"), { persisted });
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("start registers the worker, checks once and reports current", async () => {
  const t = setup();
  expect(t.store.getSnapshot()).toEqual({ state: "idle", reason: null, checkedAt: null });
  await t.started();
  expect(t.container.register.mock.calls).toEqual([["/sw.js"]]);
  expect(t.registration.update).toHaveBeenCalledTimes(1);
  // The start check is silent: it never flashes "checking".
  expect(t.states).not.toContain("checking");
  expect(t.store.getSnapshot()).toEqual({ state: "current", reason: null, checkedAt: 1_000_000 });
  t.store.start();
  expect(t.container.register).toHaveBeenCalledTimes(1);
});

test("updates are unsupported outside production", () => {
  const t = setup({ production: false });
  t.store.start();
  expect(t.store.getSnapshot().state).toBe("unsupported");
  expect(t.container.register).not.toHaveBeenCalled();
});

test("updates are unsupported without a service worker", () => {
  const t = setup();
  const store = createAppUpdate(() => makeDeps({ ...t.parts, container: undefined }));
  store.start();
  expect(store.getSnapshot().state).toBe("unsupported");
  expect(t.container.register).not.toHaveBeenCalled();
});

test("a registration failure keeps the app usable and reports an error", async () => {
  const t = setup();
  t.container.register.mockRejectedValueOnce(new Error("blocked"));
  const failed = Promise.withResolvers<void>();
  const unsubscribe = t.store.subscribe(() => {
    if (t.store.getSnapshot().state === "error") failed.resolve();
  });
  t.store.start();
  await failed.promise;
  unsubscribe();
  expect(t.store.getSnapshot().state).toBe("error");
  expect(t.store.getSnapshot().reason).toBe("the update worker could not be registered");
});

test("returning to the tab checks at most once every 60 seconds", async () => {
  const t = setup();
  await t.started();
  t.time.now += RETURN_CHECK_INTERVAL_MS - 1;
  t.document.dispatchEvent(new Event("visibilitychange"));
  t.page.dispatchEvent(pageshow(true));
  expect(t.registration.update).toHaveBeenCalledTimes(1);
  t.time.now += 1;
  t.page.dispatchEvent(pageshow(false));
  expect(t.registration.update).toHaveBeenCalledTimes(1);
  t.document.visibilityState = "hidden";
  t.document.dispatchEvent(new Event("visibilitychange"));
  expect(t.registration.update).toHaveBeenCalledTimes(1);
  t.document.visibilityState = "visible";
  t.document.dispatchEvent(new Event("visibilitychange"));
  expect(t.registration.update).toHaveBeenCalledTimes(2);
  await flush();
  t.time.now += RETURN_CHECK_INTERVAL_MS;
  t.page.dispatchEvent(pageshow(true));
  expect(t.registration.update).toHaveBeenCalledTimes(3);
});

test("checkForUpdate runs on demand, once at a time", async () => {
  const t = setup();
  await t.started();
  const first = t.store.checkForUpdate();
  const second = t.store.checkForUpdate();
  expect(t.store.getSnapshot().state).toBe("checking");
  await Promise.all([first, second]);
  expect(t.registration.update).toHaveBeenCalledTimes(2);
  expect(t.store.getSnapshot().state).toBe("current");
});

test("a failing start or return check stays silent; only the button shows the error", async () => {
  const t = setup();
  t.registration.update.mockRejectedValueOnce(new Error("offline"));
  await t.started();
  expect(t.store.getSnapshot()).toEqual({ state: "idle", reason: null, checkedAt: null });
  await t.store.checkForUpdate();
  expect(t.store.getSnapshot()).toEqual({ state: "current", reason: null, checkedAt: 1_000_000 });
  t.time.now += RETURN_CHECK_INTERVAL_MS;
  t.registration.update.mockRejectedValueOnce(new Error("offline"));
  t.page.dispatchEvent(pageshow(true));
  expect(t.registration.update).toHaveBeenCalledTimes(3);
  await flush();
  expect(t.store.getSnapshot()).toEqual({ state: "current", reason: null, checkedAt: 1_000_000 });
  expect(t.states).not.toContain("error");
});

test("the button's check shows a short error reason, and a later check recovers", async () => {
  const t = setup();
  await t.started();
  t.registration.update.mockRejectedValueOnce(new Error(`Failed to fetch\n${"x".repeat(300)}`));
  await t.store.checkForUpdate();
  expect(t.store.getSnapshot()).toMatchObject({ state: "error", reason: "Failed to fetch", checkedAt: 1_000_000 });
  t.time.now += 5;
  await t.store.checkForUpdate();
  expect(t.store.getSnapshot()).toEqual({ state: "current", reason: null, checkedAt: 1_000_005 });
  t.registration.update.mockRejectedValueOnce("odd");
  await t.store.checkForUpdate();
  expect(t.store.getSnapshot().reason).toBe("the check failed");
});

test("a check that throws synchronously leaves nothing stuck in flight", async () => {
  const t = setup();
  await t.started();
  t.registration.update.mockImplementationOnce(() => {
    throw new Error("sync");
  });
  await t.store.checkForUpdate();
  expect(t.store.getSnapshot()).toMatchObject({ state: "error", reason: "sync" });
  await t.store.checkForUpdate();
  expect(t.registration.update).toHaveBeenCalledTimes(3);
  expect(t.store.getSnapshot().state).toBe("current");
});

test("a worker waiting at start is available at once, before the check ends", async () => {
  const t = setup();
  t.registration.waiting = new FakeWorker();
  t.registration.update.mockImplementation(() => new Promise(() => {}));
  const available = Promise.withResolvers<void>();
  const unsubscribe = t.store.subscribe(() => {
    if (t.store.getSnapshot().state === "available") available.resolve();
  });
  t.store.start();
  await available.promise;
  unsubscribe();
  expect(t.store.getSnapshot().state).toBe("available");
  expect(t.states).not.toContain("checking");
});

test("the very first install is never shown as an update", async () => {
  const t = setup({ controlled: false });
  t.registration.waiting = new FakeWorker();
  await t.started();
  expect(t.store.getSnapshot().state).toBe("current");
  const worker = new FakeWorker();
  t.registration.installing = worker;
  t.registration.dispatchEvent(new Event("updatefound"));
  worker.become("installed");
  t.container.controllerChange();
  expect(t.store.getSnapshot().state).toBe("current");
  expect(t.reload).not.toHaveBeenCalled();
});

test("updatefound then installed makes the update available", async () => {
  const t = setup();
  await t.started();
  const worker = new FakeWorker();
  t.registration.installing = worker;
  t.registration.dispatchEvent(new Event("updatefound"));
  worker.become("installing");
  expect(t.store.getSnapshot().state).toBe("current");
  t.registration.waiting = worker;
  worker.become("installed");
  expect(t.store.getSnapshot().state).toBe("available");
});

test("an install already running at register: the check waits for it, then reports available", async () => {
  const t = setup();
  const worker = new FakeWorker();
  t.registration.installing = worker;
  await t.started();
  // The check returned, but the worker is still installing: not "current" yet.
  expect(t.store.getSnapshot()).toEqual({ state: "idle", reason: null, checkedAt: null });
  t.registration.installing = null;
  t.registration.waiting = worker;
  t.time.now += 7;
  worker.become("installed");
  expect(t.store.getSnapshot()).toEqual({ state: "available", reason: null, checkedAt: 1_000_007 });
});

test("a button check stays checking while a worker installs, and ends current if it goes redundant", async () => {
  const t = setup();
  await t.started();
  const worker = new FakeWorker();
  t.registration.installing = worker;
  t.registration.dispatchEvent(new Event("updatefound"));
  await t.store.checkForUpdate();
  expect(t.store.getSnapshot().state).toBe("checking");
  t.registration.installing = null;
  t.time.now += 3;
  worker.become("redundant");
  expect(t.store.getSnapshot()).toEqual({ state: "current", reason: null, checkedAt: 1_000_003 });
});

test("a check waiting on a worker that never settles ends after the timeout; settling in time clears the timer", async () => {
  const t = setup();
  await t.started();
  t.registration.installing = new FakeWorker();
  t.registration.dispatchEvent(new Event("updatefound"));
  await t.store.checkForUpdate();
  expect(t.store.getSnapshot().state).toBe("checking");
  expect(t.timers.map((timer) => timer.ms)).toEqual([SETTLE_TIMEOUT_MS]);
  t.time.now += SETTLE_TIMEOUT_MS;
  t.fireTimers();
  expect(t.store.getSnapshot()).toEqual({ state: "current", reason: null, checkedAt: 1_000_000 + SETTLE_TIMEOUT_MS });
  const worker = new FakeWorker();
  t.registration.installing = worker;
  t.registration.dispatchEvent(new Event("updatefound"));
  await t.store.checkForUpdate();
  const timer = t.timers[0];
  expect(timer?.cleared).toBe(false);
  t.registration.installing = null;
  worker.become("redundant");
  expect(timer?.cleared).toBe(true);
  expect(t.store.getSnapshot().state).toBe("current");
});

test("a worker that is already installed at register is available", async () => {
  const t = setup();
  const worker = new FakeWorker();
  worker.state = "installed";
  t.registration.waiting = worker;
  t.registration.installing = worker;
  await t.started();
  expect(t.store.getSnapshot().state).toBe("available");
});

async function availableUpdate() {
  const t = setup();
  const waiting = new FakeWorker();
  t.registration.waiting = waiting;
  await t.started();
  expect(t.store.getSnapshot().state).toBe("available");
  return { ...t, waiting };
}

test("installUpdate posts the exact message and reloads once on controllerchange", async () => {
  const t = await availableUpdate();
  t.store.installUpdate();
  expect(t.waiting.postMessage.mock.calls).toEqual([[{ type: "SKIP_WAITING" }]]);
  expect(t.store.getSnapshot().state).toBe("updating");
  expect(t.timers.map((timer) => timer.ms)).toEqual([INSTALL_TIMEOUT_MS]);
  expect(t.reload).not.toHaveBeenCalled();
  t.container.controllerChange();
  t.container.controllerChange();
  expect(t.reload).toHaveBeenCalledTimes(1);
  expect(t.timers[0]?.cleared).toBe(true);
  t.store.installUpdate();
  expect(t.waiting.postMessage).toHaveBeenCalledTimes(1);
});

test("installUpdate does nothing unless an update is available", async () => {
  const t = setup();
  await t.started();
  t.store.installUpdate();
  expect(t.store.getSnapshot().state).toBe("current");
});

test("a postMessage that throws ends in an error, not in Updating", async () => {
  const t = await availableUpdate();
  t.waiting.postMessage.mockImplementation(() => {
    throw new Error("detached");
  });
  t.store.installUpdate();
  expect(t.store.getSnapshot()).toMatchObject({ state: "error", reason: "the update could not be started" });
  t.container.controllerChange();
  expect(t.reload).not.toHaveBeenCalled();
  expect(t.store.getSnapshot().state).toBe("reload-needed");
});

test("Updating times out back to available, and a later controllerchange asks for a reload", async () => {
  const t = await availableUpdate();
  t.store.installUpdate();
  t.fireTimers();
  expect(t.store.getSnapshot().state).toBe("available");
  t.container.controllerChange();
  expect(t.reload).not.toHaveBeenCalled();
  expect(t.store.getSnapshot().state).toBe("reload-needed");
});

test("Updating times out into an error when no worker waits any more", async () => {
  const t = await availableUpdate();
  t.store.installUpdate();
  t.registration.waiting = null;
  t.fireTimers();
  expect(t.store.getSnapshot()).toMatchObject({ state: "error", reason: "the update did not finish" });
});

test("a worker that goes redundant while updating sets an error", async () => {
  const t = await availableUpdate();
  t.store.installUpdate();
  t.registration.waiting = null;
  t.waiting.become("redundant");
  expect(t.store.getSnapshot()).toMatchObject({ state: "error", reason: "the update could not be installed" });
  expect(t.timers[0]?.cleared).toBe(true);
});

test("a redundant worker with a newer one waiting leaves the update available", async () => {
  const t = await availableUpdate();
  t.store.installUpdate();
  t.registration.waiting = new FakeWorker();
  t.waiting.become("redundant");
  expect(t.store.getSnapshot()).toMatchObject({ state: "available", reason: null });
});

test("a controllerchange this tab did not ask for sets reload-needed and never reloads", async () => {
  const t = setup();
  await t.started();
  t.container.controllerChange();
  expect(t.store.getSnapshot().state).toBe("reload-needed");
  expect(t.reload).not.toHaveBeenCalled();
  await t.store.checkForUpdate();
  expect(t.store.getSnapshot().state).toBe("reload-needed");
  t.store.reloadNow();
  expect(t.reload).toHaveBeenCalledTimes(1);
});

test("a window with no worker at start ignores the first claim and flags a later foreign change", async () => {
  const t = setup({ controlled: false });
  await t.started();
  t.container.controllerChange();
  expect(t.store.getSnapshot().state).toBe("current");
  t.container.controllerChange();
  expect(t.store.getSnapshot().state).toBe("reload-needed");
});

test("a controller swapped without an event is noticed on return, before the throttle", async () => {
  const t = setup();
  await t.started();
  t.container.controller = {};
  // Inside the throttle window: no new check, but the swap is still noticed.
  t.time.now += 1;
  t.document.dispatchEvent(new Event("visibilitychange"));
  expect(t.store.getSnapshot().state).toBe("reload-needed");
  expect(t.registration.update).toHaveBeenCalledTimes(1);
  expect(t.reload).not.toHaveBeenCalled();
});

test("a controller that appears after a first claim, or one this tab installed, is not a swap", async () => {
  const first = setup({ controlled: false });
  await first.started();
  first.container.controller = {};
  first.page.dispatchEvent(pageshow(true));
  expect(first.store.getSnapshot().state).not.toBe("reload-needed");
  const own = await availableUpdate();
  own.store.installUpdate();
  own.container.controller = {};
  own.document.dispatchEvent(new Event("visibilitychange"));
  expect(own.store.getSnapshot().state).toBe("updating");
});

test("a check never hides an available update", async () => {
  const t = await availableUpdate();
  t.registration.update.mockRejectedValueOnce(new Error("offline"));
  await t.store.checkForUpdate();
  expect(t.store.getSnapshot().state).toBe("available");
  await t.store.checkForUpdate();
  expect(t.store.getSnapshot().state).toBe("available");
});

test("buildTag reads the hashed entry file name and skips anything else", () => {
  expect(buildTag("/assets/app-AbCd1234.js")).toBe("AbCd1234");
  expect(buildTag("https://hub.example.ts.net/assets/app-AbCd1234.js?x=1")).toBe("AbCd1234");
  expect(buildTag("/src/main.tsx")).toBeNull();
  expect(buildTag("")).toBeNull();
  expect(buildTag()).toBeNull();
  // A real script element would make happy-dom try to load the file.
  const query = vi.spyOn(document, "querySelector").mockReturnValue({
    getAttribute: () => "/assets/app-Zz9Yy8Xx.js",
  } as unknown as Element);
  try {
    expect(buildTag()).toBe("Zz9Yy8Xx");
  } finally {
    query.mockRestore();
  }
});
