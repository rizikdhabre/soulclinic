import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTreatmentOrderQueue } from "@/lib/treatmentOrderQueue";

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const order = (...ids) => ({ order: ids });

describe("durable treatment order outbox", () => {
  const queues = [];
  function setup(options = {}) {
    const storage = options.storage || memoryStorage();
    const send = options.send || vi.fn().mockResolvedValue(undefined);
    const queue = createTreatmentOrderQueue({ storage, storageKey: "admin:1", send, ...options });
    queues.push(queue);
    return { queue, storage, send };
  }
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { queues.forEach(queue => queue.dispose()); queues.length = 0; vi.useRealTimers(); });

  it("persists and submits a drag immediately, even if disposed before any timer runs", async () => {
    const request = deferred();
    const { queue, storage, send } = setup({ send: vi.fn(() => request.promise) });
    queue.enqueue("main", order("b", "a"));
    expect(storage.getItem("admin:1")).toContain('"b","a"');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0].slice(0, 2)).toEqual([order("b", "a"), "main"]);
    queue.dispose();
    expect(send).toHaveBeenCalledOnce();
    request.resolve({ status: 202 });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getPending()).toEqual({});
  });

  it("sends the next drag immediately after admission without a client-side five-second delay", async () => {
    const { queue, send } = setup();
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(0);
    queue.enqueue("main", order("a", "b"));
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getPending()).toEqual({});
  });

  it("restores undelivered main and subtreatment orders when reopened online", async () => {
    const { queue, storage, send } = setup({ isOnline: () => false });
    queue.enqueue("main", order("b", "a"));
    queue.enqueue("treatment-1", { treatmentId: "treatment-1", order: ["s2", "s1"] });
    queue.dispose();
    expect(send).not.toHaveBeenCalled();
    const reopened = setup({ storage });
    expect(reopened.queue.getPending()).toEqual({ main: order("b", "a"), "treatment-1": { treatmentId: "treatment-1", order: ["s2", "s1"] } });
    reopened.queue.resume();
    expect(reopened.send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(reopened.send).toHaveBeenCalledTimes(2);
    expect(reopened.queue.getPending()).toEqual({});
  });

  it("retains offline changes and submits them when connectivity returns", async () => {
    let online = false;
    const { queue, send } = setup({ isOnline: () => online });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
    online = true;
    queue.resume();
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getPending()).toEqual({});
  });

  it("backs off failed admissions and only removes confirmed pending changes", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("network unavailable")).mockRejectedValueOnce({ response: { status: 503 } }).mockResolvedValue(undefined);
    const { queue } = setup({ send });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getPending()).toEqual({ main: order("b", "a") });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(3);
    expect(queue.getPending()).toEqual({});
  });

  it("serializes admission while open and preserves newer drags after an older acknowledgement", async () => {
    const first = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const { queue } = setup({ send });
    queue.enqueue("main", order("b", "a"));
    queue.enqueue("main", order("a", "b"));
    queue.enqueue("treatment-1", { treatmentId: "treatment-1", order: ["s2", "s1"] });
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1][0]).toEqual(order("a", "b"));
    expect(queue.getPending()).toEqual({});
  });

  it.each(["flushOnExit", "dispose"])("%s immediately flushes newer queued intents alongside an older in-flight request", async method => {
    const first = deferred(), latest = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise).mockResolvedValue(undefined);
    const { queue } = setup({ send });
    queue.enqueue("main", order("b", "a"));
    queue.enqueue("main", order("c", "b", "a"));
    queue.enqueue("treatment-1", { treatmentId: "treatment-1", order: ["s2", "s1"] });
    queue[method]();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1][0]).toEqual(order("c", "b", "a"));
    expect(send.mock.calls[1][2].sequence).toBeGreaterThan(send.mock.calls[0][2].sequence);
    queue[method]();
    expect(send).toHaveBeenCalledTimes(3);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getPending()).toEqual({ main: order("c", "b", "a") });
    latest.resolve({ status: 202 });
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getPending()).toEqual({});
  });

  it("stops retry timers after pagehide and resumes on returning from the back/forward cache", async () => {
    const send = vi.fn().mockRejectedValue(new Error("network lost"));
    const { queue } = setup({ send });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(0);
    queue.flushOnExit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(queue.getPending()).toEqual({ main: order("b", "a") });
    send.mockResolvedValue(undefined);
    queue.resume();
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getPending()).toEqual({});
  });

  it("does not acknowledge another tab's newer order", async () => {
    let online = true;
    const first = deferred();
    const { queue, storage } = setup({ send: () => first.promise, isOnline: () => online });
    queue.enqueue("main", order("b", "a"));
    const other = setup({ storage, isOnline: () => false });
    other.queue.enqueue("main", order("c", "b", "a"));
    online = false;
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getPending()).toEqual({ main: order("c", "b", "a") });
    expect(other.queue.getPending()).toEqual({ main: order("c", "b", "a") });
  });

  it("pauses authorization failures until resumed without losing the order", async () => {
    const send = vi.fn().mockRejectedValueOnce({ response: { status: 401 } }).mockResolvedValue(undefined);
    const { queue } = setup({ send });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    queue.resume();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("recovers an unacknowledged failed request after disposal and reopening", async () => {
    const request = deferred();
    const { queue, storage } = setup({ send: () => request.promise });
    queue.enqueue("main", order("b", "a"));
    queue.dispose();
    request.reject(new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(0);
    const reopened = setup({ storage });
    expect(reopened.queue.getPending()).toEqual({ main: order("b", "a") });
    reopened.queue.resume();
    expect(reopened.send).toHaveBeenCalledOnce();
  });

  it("survives unavailable storage without crashing or preventing admission", async () => {
    const unavailable = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    const { queue, send } = setup({ storage: unavailable });
    expect(() => queue.enqueue("main", order("b", "a"))).not.toThrow();
    expect(send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getPending()).toEqual({});
  });

  it("ignores malformed saved state and keeps accounts isolated", () => {
    const storage = memoryStorage();
    storage.setItem("admin:1", "not json");
    const first = setup({ storage, isOnline: () => false });
    first.queue.enqueue("main", order("b", "a"));
    const second = setup({ storage, storageKey: "admin:2" });
    expect(second.queue.getPending()).toEqual({});
    expect(first.queue.getPending()).toEqual({ main: order("b", "a") });
  });

  it("retains device identity and increases sequence after acknowledgement and reopening", async () => {
    const first = setup();
    first.queue.enqueue("main", order("b", "a"));
    const original = first.send.mock.calls[0][2];
    expect(original).toEqual({ clientId: expect.any(String), sequence: 1 });
    await vi.advanceTimersByTimeAsync(0);
    first.queue.dispose();
    const reopened = setup({ storage: first.storage });
    reopened.queue.enqueue("main", order("a", "b"));
    expect(reopened.send.mock.calls[0][2]).toEqual({ clientId: original.clientId, sequence: 2 });
  });

  it("keeps the same sequence on retry after a lost admission response", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue(undefined);
    const { queue } = setup({ send });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][2]).toEqual(send.mock.calls[0][2]);
  });

  it("recovers an existing browser-debounced queue without preserving its obsolete delay", async () => {
    const storage = memoryStorage();
    storage.setItem("admin:1", JSON.stringify({ version: 1, clientId: "existing-device", sequence: 7,
      quietUntil: Date.now() + 5_000, entries: { main: { payload: order("b", "a"), sequence: 7,
        changedAt: Date.now(), nextAttemptAt: Date.now() + 5_000, attempts: 0, paused: false } } }));
    const { queue, send } = setup({ storage });
    queue.resume();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][2]).toEqual({ clientId: "existing-device", sequence: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(storage.getItem("admin:1"))).toMatchObject({ version: 2, clientId: "existing-device", sequence: 7, entries: {} });
  });
});
