import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createTreatmentOrderQueue } = await import("@/lib/treatmentOrderQueue").catch(() => ({}));

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

describe("durable treatment order queue", () => {
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

  it("persists immediately but sends only five seconds after the last drag", async () => {
    const { queue, storage, send } = setup();
    queue.enqueue("main", order("b", "a"));
    expect(storage.getItem("admin:1")).toContain('"b","a"');
    await vi.advanceTimersByTimeAsync(4_000);
    queue.enqueue("main", order("a", "b"));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0].slice(0, 2)).toEqual([order("a", "b"), "main"]);
    expect(queue.getPending()).toEqual({});
  });

  it("restores both kinds of pending order after closing and reopening without flushing early", async () => {
    const { queue, storage, send } = setup();
    queue.enqueue("main", order("b", "a"));
    queue.enqueue("treatment-1", { treatmentId: "treatment-1", order: ["s2", "s1"] });
    await vi.advanceTimersByTimeAsync(2_000);
    queue.dispose();
    expect(send).not.toHaveBeenCalled();
    const reopened = setup({ storage });
    expect(reopened.queue.getPending()).toEqual({ main: order("b", "a"), "treatment-1": { treatmentId: "treatment-1", order: ["s2", "s1"] } });
    reopened.queue.resume();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(reopened.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(reopened.send).toHaveBeenCalledTimes(2);
    expect(reopened.queue.getPending()).toEqual({});
  });

  it("retains offline changes and sends when connectivity returns", async () => {
    let online = false;
    const { queue, send } = setup({ isOnline: () => online });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
    expect(queue.getPending()).toEqual({ main: order("b", "a") });
    online = true;
    queue.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    expect(queue.getPending()).toEqual({});
  });

  it("retries connection failures with backoff and keeps changes until confirmed", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("network unavailable")).mockRejectedValueOnce({ response: { status: 503 } }).mockResolvedValue(undefined);
    const { queue } = setup({ send });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getPending()).toEqual({ main: order("b", "a") });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    expect(queue.getPending()).toEqual({});
  });

  it("sends one request at a time and an earlier acknowledgement cannot erase a newer drag", async () => {
    const first = deferred();
    const send = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const { queue } = setup({ send });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(5_000);
    queue.enqueue("main", order("a", "b"));
    queue.enqueue("treatment-1", { treatmentId: "treatment-1", order: ["s2", "s1"] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[1][0]).toEqual(order("a", "b"));
    expect(queue.getPending()).toEqual({});
  });

  it("does not acknowledge another tab's newer order", async () => {
    const first = deferred();
    const { queue, storage } = setup({ send: () => first.promise });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(5_000);
    const other = setup({ storage, isOnline: () => false });
    other.queue.enqueue("main", order("c", "b", "a"));
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.getPending()).toEqual({ main: order("c", "b", "a") });
    expect(other.queue.getPending()).toEqual({ main: order("c", "b", "a") });
  });

  it("pauses authorization failures until resumed without losing the order", async () => {
    const send = vi.fn().mockRejectedValueOnce({ response: { status: 401 } }).mockResolvedValue(undefined);
    const { queue } = setup({ send });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(65_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(queue.getPending()).toEqual({ main: order("b", "a") });
    queue.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed request pending if the page is disposed while it is in flight", async () => {
    const request = deferred();
    const { queue, storage } = setup({ send: () => request.promise });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(5_000);
    queue.dispose();
    request.reject(new Error("connection lost"));
    await vi.advanceTimersByTimeAsync(0);
    const reopened = setup({ storage });
    expect(reopened.queue.getPending()).toEqual({ main: order("b", "a") });
    reopened.queue.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reopened.send).toHaveBeenCalledOnce();
  });

  it("survives unavailable storage without crashing or delaying successful saves indefinitely", async () => {
    const unavailable = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
    const { queue, send } = setup({ storage: unavailable });
    expect(() => queue.enqueue("main", order("b", "a"))).not.toThrow();
    expect(queue.getPending()).toEqual({ main: order("b", "a") });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledOnce();
    expect(queue.getPending()).toEqual({});
  });

  it("ignores malformed saved state and keeps accounts isolated", async () => {
    const storage = memoryStorage();
    storage.setItem("admin:1", "not json");
    const first = setup({ storage });
    first.queue.enqueue("main", order("b", "a"));
    const second = setup({ storage, storageKey: "admin:2" });
    expect(second.queue.getPending()).toEqual({});
    expect(first.queue.getPending()).toEqual({ main: order("b", "a") });
  });

  it("retains device identity and increases the sequence after acknowledgements and reopening", async () => {
    const first = setup();
    first.queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(5_000);
    const original = first.send.mock.calls[0][2];
    expect(original).toEqual({ clientId: expect.any(String), sequence: 1 });
    first.queue.dispose();
    const reopened = setup({ storage: first.storage });
    reopened.queue.enqueue("main", order("a", "b"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reopened.send.mock.calls[0][2]).toEqual({ clientId: original.clientId, sequence: 2 });
  });

  it("keeps the same sequence for retries so the server can safely acknowledge an earlier attempt", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue(undefined);
    const { queue } = setup({ send });
    queue.enqueue("main", order("b", "a"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][2]).toEqual(send.mock.calls[0][2]);
  });
});
