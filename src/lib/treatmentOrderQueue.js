const RETRY_DELAYS = [5_000, 10_000, 20_000, 30_000];
const copy = value => JSON.parse(JSON.stringify(value));
const makeClientId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function emptyState() {
  return { version: 2, clientId: makeClientId(), sequence: 0, entries: {} };
}

function validState(value) {
  return [1, 2].includes(value?.version) && typeof value.clientId === "string" && value.clientId.length > 0 &&
    Number.isSafeInteger(value.sequence) && value.sequence >= 0 &&
    value.entries && typeof value.entries === "object" && !Array.isArray(value.entries) &&
    Object.values(value.entries).every(entry => entry && Number.isSafeInteger(entry.sequence) &&
      entry.sequence > 0 && entry.sequence <= value.sequence && Number.isFinite(entry.changedAt) &&
      Number.isFinite(entry.nextAttemptAt) && Number.isInteger(entry.attempts) && entry.attempts >= 0 &&
      Array.isArray(entry.payload?.order) && entry.payload.order.every(id => typeof id === "string"));
}

/**
 * getPending()/onChange expose { [targetKey]: payload }; storage retains retry
 * metadata too. send(payload, targetKey, {clientId, sequence}) must resolve only
 * after durable server admission. The server owns the five-second debounce.
 * Call resume on reconnect/pageshow, flushOnExit on pagehide, dispose on unmount.
 */
export function createTreatmentOrderQueue({
  storage, storageKey, send, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  isOnline = () => true, onChange,
}) {
  let state = emptyState();
  let timer = null;
  const inFlight = new Set();
  let disposed = false;
  let suspended = false;
  let memoryOnly = !storage;

  function load() {
    if (memoryOnly) return;
    try {
      const raw = storage.getItem(storageKey);
      const saved = raw ? JSON.parse(raw) : null;
      if (validState(saved)) {
        state = { ...saved, version: 2 };
        delete state.quietUntil;
      }
      else if (raw) state = emptyState();
    } catch (error) {
      // Invalid JSON is disposable; blocked storage falls back to this tab's
      // memory. Persistence across closing is unavailable when storage is blocked.
      if (error instanceof SyntaxError) state = emptyState();
      else memoryOnly = true;
    }
  }

  function pending() {
    return Object.fromEntries(Object.entries(state.entries).map(([key, entry]) => [key, copy(entry.payload)]));
  }

  function persist() {
    try { storage?.setItem(storageKey, JSON.stringify(state)); }
    catch { memoryOnly = true; }
    if (!disposed && !suspended) onChange?.(pending());
  }

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function schedule() {
    cancelTimer();
    if (disposed || suspended || inFlight.size || !isOnline()) return;
    load();
    const ready = Object.values(state.entries).filter(entry => !entry.paused);
    if (!ready.length) return;
    const due = Math.min(...ready.map(entry => entry.nextAttemptAt));
    timer = setTimer(run, Math.max(0, due - now()));
  }

  function run() {
    cancelTimer();
    if (disposed || suspended || inFlight.size || !isOnline()) return;
    load();
    const candidate = Object.entries(state.entries)
      .filter(([, entry]) => !entry.paused && entry.nextAttemptAt <= now())
      .sort((a, b) => a[1].sequence - b[1].sequence)[0];
    if (!candidate) { schedule(); return; }
    const [key, entry] = candidate;
    void deliver(key, entry, state.clientId);
  }

  async function deliver(key, entry, clientId) {
    const requestId = `${clientId}:${entry.sequence}:${key}`;
    if (inFlight.has(requestId)) return;
    inFlight.add(requestId);
    try {
      await send(copy(entry.payload), key, { clientId, sequence: entry.sequence });
      load();
      // A newer drag (including another tab's) must survive this older reply.
      if (state.clientId === clientId && state.entries[key]?.sequence === entry.sequence) {
        delete state.entries[key];
        persist();
      }
    } catch (error) {
      load();
      if (state.clientId === clientId && state.entries[key]?.sequence === entry.sequence) {
        const status = Number(error?.response?.status ?? error?.status);
        const paused = status >= 400 && status < 500 && ![408, 409, 429].includes(status);
        const attempts = entry.attempts + 1;
        state.entries[key] = { ...entry, attempts, paused,
          nextAttemptAt: now() + RETRY_DELAYS[Math.min(attempts - 1, RETRY_DELAYS.length - 1)] };
        persist();
      }
    } finally {
      inFlight.delete(requestId);
      run();
    }
  }

  function flushOnExit() {
    if (disposed) return;
    suspended = true;
    cancelTimer();
    if (!isOnline()) return;
    load();
    // Do not wait for an older request's callback: the document may be destroyed
    // before it runs. keepalive sends plus server sequence checks make this one
    // exit-only concurrent flush safe; matching in-flight requests are deduped.
    for (const [key, entry] of Object.entries(state.entries)) {
      if (!entry.paused) void deliver(key, entry, state.clientId);
    }
  }

  load();
  return {
    enqueue(key, payload) {
      if (disposed) return;
      load();
      const changedAt = now();
      const sequence = ++state.sequence;
      suspended = false;
      state.entries[key] = { payload: copy(payload), sequence, changedAt,
        nextAttemptAt: changedAt, attempts: 0, paused: false };
      persist();
      // Start admission in this same call stack, not in a cancelable timer.
      run();
    },
    getPending() { load(); return pending(); },
    resume() {
      if (disposed) return;
      suspended = false;
      load();
      for (const entry of Object.values(state.entries)) {
        entry.paused = false;
        entry.nextAttemptAt = Math.min(entry.nextAttemptAt, now());
      }
      persist();
      run();
    },
    flushOnExit,
    dispose() { flushOnExit(); disposed = true; cancelTimer(); },
  };
}
