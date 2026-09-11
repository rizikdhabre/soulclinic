import { ObjectId } from "mongodb";
import { AsyncLocalStorage } from "node:async_hooks";

function clone(value) {
  if (value === undefined || value === null) return value;
  if (value instanceof Date) return new Date(value);
  if (value instanceof ObjectId) return new ObjectId(value.toHexString());
  if (Array.isArray(value)) return value.map(clone);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clone(item)]),
    );
  }
  return value;
}

function equal(left, right) {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  return left === right;
}

function matchesCondition(actual, expected) {
  if (actual instanceof ObjectId && expected instanceof ObjectId) {
    return actual.equals(expected);
  }
  if (
    expected === null ||
    typeof expected !== "object" ||
    expected instanceof Date ||
    Array.isArray(expected)
  ) {
    return equal(actual, expected);
  }

  return Object.entries(expected).every(([operator, operand]) => {
    if (operator === "$in") return operand.some((value) => matchesCondition(actual, value));
    if (operator === "$exists") return (actual !== undefined) === operand;
    if (operator === "$ne") return !matchesCondition(actual, operand);
    if (operator === "$gt") return actual > operand;
    if (operator === "$gte") return actual >= operand;
    if (operator === "$lt") return actual < operand;
    if (operator === "$lte") return actual <= operand;
    if (operator === "$type") {
      if (operand === "objectId") {
        return actual?.constructor?.name === "ObjectId";
      }
      return typeof actual === operand;
    }
    return equal(actual?.[operator], operand);
  });
}

function resolveExpressionValue(document, value, serverNow) {
  if (value === "$$NOW") return serverNow;
  if (typeof value === "string" && value.startsWith("$")) {
    return document[value.slice(1)];
  }
  return value;
}

function matchesExpression(document, expression, serverNow) {
  if (!expression || typeof expression !== "object") return false;

  return Object.entries(expression).every(([operator, operands]) => {
    if (!Array.isArray(operands) || operands.length !== 2) return false;
    const [left, right] = operands.map((value) =>
      resolveExpressionValue(document, value, serverNow),
    );
    if (operator === "$gt") return left > right;
    if (operator === "$gte") return left >= right;
    if (operator === "$lt") return left < right;
    if (operator === "$lte") return left <= right;
    if (operator === "$eq") return equal(left, right);
    return false;
  });
}

function matches(document, filter, serverNow = new Date()) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$expr") return matchesExpression(document, value, serverNow);
    return matchesCondition(document[key], value);
  });
}

function applyUpdate(document, update) {
  const next = { ...document, ...clone(update.$set ?? {}) };

  for (const [key, value] of Object.entries(update.$setOnInsert ?? {})) {
    if (!Object.hasOwn(next, key)) next[key] = clone(value);
  }
  for (const [key, increment] of Object.entries(update.$inc ?? {})) {
    next[key] = (next[key] ?? 0) + increment;
  }
  for (const key of Object.keys(update.$unset ?? {})) {
    delete next[key];
  }

  return next;
}

function equalityFields(filter) {
  return Object.fromEntries(
    Object.entries(filter).filter(
      ([, value]) =>
        value === null ||
        typeof value !== "object" ||
        value instanceof Date ||
        Array.isArray(value),
    ),
  );
}

export class MemoryVersionedCollection {
  constructor(uniqueKey) {
    this.uniqueKey = uniqueKey;
    this.documents = [];
    this.indexes = [];
    this.nextId = 1;
    this.forcedCasConflicts = 0;
    this.duplicateKeyErrors = 0;
  }

  async findOne(filter) {
    return clone(this.documents.find((document) => matches(document, filter)) ?? null);
  }

  async insertOne(document) {
    if (this.documents.some((item) => item[this.uniqueKey] === document[this.uniqueKey])) {
      this.duplicateKeyErrors += 1;
      const error = new Error("Duplicate key");
      error.code = 11000;
      throw error;
    }

    const stored = { ...clone(document), _id: this.nextId };
    this.nextId += 1;
    this.documents.push(stored);
    return { acknowledged: true, insertedId: stored._id };
  }

  async updateOne(filter, update) {
    if (!Object.hasOwn(filter, "_id") || !Object.hasOwn(filter, "version")) {
      throw new Error("Versioned updates require an _id + version CAS filter");
    }
    if (Object.hasOwn(update.$set ?? {}, "_id") || Object.hasOwn(update.$set ?? {}, "version")) {
      throw new Error("MongoDB cannot $set immutable or conflicting version fields");
    }

    if (this.forcedCasConflicts > 0) {
      this.forcedCasConflicts -= 1;
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }

    const index = this.documents.findIndex((document) => matches(document, filter));
    if (index === -1) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }

    const current = this.documents[index];
    const next = { ...current, ...clone(update.$set ?? {}) };
    for (const [key, increment] of Object.entries(update.$inc ?? {})) {
      next[key] = (next[key] ?? 0) + increment;
    }
    this.documents[index] = next;
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }

  async createIndex(keys, options = {}) {
    this.indexes.push({ keys: clone(keys), options: clone(options) });
    return options.name ?? Object.keys(keys).join("_");
  }
}

export class MemoryMongoCollection {
  constructor(documents = []) {
    this.documents = clone(documents);
    this.indexes = [];
    this.calls = [];
    this.nextId = 1;
    this.failNextPrepare = false;
    this.failNextWriteWith = null;
    this.failNextFinalize = false;
    this.failNextDelete = false;
    this.throwAfterFinalize = false;
    this.afterNextFindOne = null;
    this.afterNextCreateIndex = null;
    this.beforeNextDelete = null;
    this.afterNextDelete = null;
    this.failNextPrepareWith = null;
    this.beforeNextPrepareFailure = null;
    this.throwAfterPrepareWith = null;
    this.finalizeErrorMode = null;
    this.deferredFinalizations = [];
    this.serverClock = null;
    this.memoryClient = null;
  }

  get current() {
    return this.documents[0] ?? null;
  }

  set current(document) {
    this.documents = document ? [clone(document)] : [];
  }

  snapshot() {
    return { documents: clone(this.documents), nextId: this.nextId };
  }

  restore(snapshot) {
    this.documents = clone(snapshot.documents);
    this.nextId = snapshot.nextId;
  }

  createTransactionState() {
    return this.snapshot();
  }

  commitTransactionState(state) {
    this.restore(state);
  }

  #serverNow() {
    return new Date(this.serverClock?.now?.() ?? Date.now());
  }

  #state(options = {}) {
    const activeSession = this.memoryClient?.transactionContext.getStore();
    if (!activeSession) {
      return { documents: this.documents, nextId: this.nextId, committed: true };
    }
    if (options.session !== activeSession) {
      throw new Error("Operation must use the active transaction session.");
    }
    return activeSession.transactionStates.get(this);
  }

  #saveState(state) {
    if (state.committed) {
      this.documents = state.documents;
      this.nextId = state.nextId;
    }
  }

  async createIndex(keys, options = {}) {
    this.indexes.push({ keys: clone(keys), options: clone(options) });
    this.#assertUniqueIndexes(this.documents);
    if (this.afterNextCreateIndex) {
      const afterCreateIndex = this.afterNextCreateIndex;
      this.afterNextCreateIndex = null;
      await afterCreateIndex();
    }
    return options.name ?? Object.keys(keys).join("_");
  }

  async findOne(filter, options = {}) {
    this.calls.push({ operation: "findOne", filter: clone(filter), options });
    const state = this.#state(options);
    const document = clone(
      state.documents.find((item) => matches(item, filter, this.#serverNow())) ?? null,
    );
    if (this.afterNextFindOne) {
      const afterFindOne = this.afterNextFindOne;
      this.afterNextFindOne = null;
      await afterFindOne();
    }
    return document;
  }

  async insertOne(document, options = {}) {
    this.calls.push({ operation: "insertOne", document: clone(document), options });
    this.#maybeFailPrepare(document);
    const state = this.#state(options);

    const stored = {
      ...clone(document),
      _id: document._id ?? `memory-${state.nextId}`,
    };
    this.#assertUniqueIndexes([...state.documents, stored]);
    state.nextId += 1;
    state.documents.push(stored);
    this.#saveState(state);
    if (this.throwAfterPrepareWith && document.status === "prepared") {
      const error = this.throwAfterPrepareWith;
      this.throwAfterPrepareWith = null;
      throw error;
    }
    return { acknowledged: true, insertedId: stored._id };
  }

  async findOneAndUpdate(filter, update, options = {}) {
    this.calls.push({
      operation: "findOneAndUpdate",
      filter: clone(filter),
      update: clone(update),
      options,
    });

    const state = this.#state(options);
    if (this.failNextWriteWith) {
      const error = this.failNextWriteWith;
      this.failNextWriteWith = null;
      throw error;
    }
    const isFinalization =
      filter.status === "completing" && update.$set?.status === "completed";

    if (this.failNextFinalize && isFinalization) {
      this.failNextFinalize = false;
      return null;
    }

    if (this.finalizeErrorMode === "before" && isFinalization) {
      this.finalizeErrorMode = null;
      throw new Error("Simulated finalize failure before commit");
    }

    let index = state.documents.findIndex((document) =>
      matches(document, filter, this.#serverNow()),
    );
    let inserted = false;
    if (index === -1 && options.upsert) {
      const document = applyUpdate(
        { ...clone(equalityFields(filter)), _id: `memory-${state.nextId}` },
        update,
      );
      this.#maybeFailPrepare(document);
      this.#assertUniqueIndexes([...state.documents, document]);
      state.nextId += 1;
      state.documents.push(document);
      index = state.documents.length - 1;
      inserted = true;
    }

    if (index === -1) return null;

    if (this.finalizeErrorMode === "deferred" && isFinalization) {
      this.finalizeErrorMode = null;
      const deferredState = {
        documents: clone(state.documents),
        nextId: state.nextId,
        committed: true,
      };
      deferredState.documents[index] = applyUpdate(
        deferredState.documents[index],
        update,
      );
      this.deferredFinalizations.push(() =>
        this.commitTransactionState(deferredState),
      );
      throw new Error("Simulated ambiguous deferred finalize result");
    }

    if (!inserted) {
      const next = applyUpdate(state.documents[index], update);
      this.#maybeFailPrepare(next, update);
      const documents = [...state.documents];
      documents[index] = next;
      this.#assertUniqueIndexes(documents);
      state.documents[index] = next;
    }

    this.#saveState(state);

    if (
      (this.throwAfterFinalize || this.finalizeErrorMode === "after") &&
      isFinalization
    ) {
      this.throwAfterFinalize = false;
      this.finalizeErrorMode = null;
      throw new Error("Simulated ambiguous finalize result");
    }

    return clone(state.documents[index]);
  }

  async updateOne(filter, update, options = {}) {
    this.calls.push({
      operation: "updateOne",
      filter: clone(filter),
      update: clone(update),
      options,
    });

    const state = this.#state(options);

    let index = state.documents.findIndex((document) =>
      matches(document, filter, this.#serverNow()),
    );
    if (index === -1 && options.upsert) {
      const document = applyUpdate(
        { ...clone(equalityFields(filter)), _id: `memory-${state.nextId}` },
        update,
      );
      this.#maybeFailPrepare(document);
      this.#assertUniqueIndexes([...state.documents, document]);
      state.nextId += 1;
      state.documents.push(document);
      this.#saveState(state);
      return {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 1,
        upsertedId: document._id,
      };
    }

    if (index === -1) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }

    const next = applyUpdate(state.documents[index], update);
    this.#maybeFailPrepare(next, update);
    const documents = [...state.documents];
    documents[index] = next;
    this.#assertUniqueIndexes(documents);
    state.documents[index] = next;
    this.#saveState(state);
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter, options = {}) {
    this.calls.push({ operation: "deleteOne", filter: clone(filter), options });
    const state = this.#state(options);
    if (this.beforeNextDelete) {
      const beforeDelete = this.beforeNextDelete;
      this.beforeNextDelete = null;
      await beforeDelete();
    }
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("Simulated grant delete failure");
    }
    const index = state.documents.findIndex((document) =>
      matches(document, filter, this.#serverNow()),
    );
    if (index === -1) return { acknowledged: true, deletedCount: 0 };

    state.documents.splice(index, 1);
    this.#saveState(state);
    if (this.afterNextDelete) {
      const afterDelete = this.afterNextDelete;
      this.afterNextDelete = null;
      await afterDelete();
    }
    return { acknowledged: true, deletedCount: 1 };
  }

  async flushDeferredWrites() {
    const writes = this.deferredFinalizations.splice(0);
    for (const write of writes) await write();
  }

  #maybeFailPrepare(document, update = {}) {
    const preparesGrant =
      document.status === "prepared" &&
      (update.$setOnInsert || !Object.keys(update).some((key) => key.startsWith("$")));
    if (!preparesGrant) return;

    if (this.failNextPrepareWith) {
      const error = this.failNextPrepareWith;
      this.failNextPrepareWith = null;
      const beforeFailure = this.beforeNextPrepareFailure;
      this.beforeNextPrepareFailure = null;
      beforeFailure?.();
      throw error;
    }
    if (!this.failNextPrepare) return;

    this.failNextPrepare = false;
    throw new Error("Simulated grant prepare failure");
  }

  #assertUniqueIndexes(documents) {
    for (const { keys, options } of this.indexes) {
      if (!options.unique) continue;

      const indexed = options.partialFilterExpression
        ? documents.filter((document) =>
            matches(document, options.partialFilterExpression),
          )
        : documents;
      const seen = new Set();
      for (const document of indexed) {
        const signature = JSON.stringify(
          Object.keys(keys).map((key) => document[key] ?? null),
        );
        if (seen.has(signature)) {
          const error = new Error("Duplicate key");
          error.code = 11000;
          throw error;
        }
        seen.add(signature);
      }
    }
  }
}

export class MemoryMongoClient {
  constructor(collections, { transactionsUnsupported = false } = {}) {
    this.collections = collections;
    this.transactionsUnsupported = transactionsUnsupported;
    this.transactionTail = Promise.resolve();
    this.activeSession = null;
    this.transactionContext = new AsyncLocalStorage();
    this.callbackRetries = 0;
    this.callbackAttempts = 0;
    this.commitAttempts = 0;
    this.onCallbackRetry = null;
    this.beforeCallbackAttempt = null;
    this.failAfterCallbackWith = null;
    this.failCommitWith = null;
    this.ambiguousCommitWith = null;
    this.afterAmbiguousCommit = null;
    this.endSessionError = null;
    for (const collection of collections) collection.memoryClient = this;
  }

  startSession() {
    const client = this;
    const session = {
      transactionStates: null,
      async withTransaction(operation) {
        if (client.transactionsUnsupported) {
          throw Object.assign(
            new Error(
              "Transaction numbers are only allowed on a replica set member or mongos",
            ),
            { code: 20, codeName: "IllegalOperation" },
          );
        }

        const previous = client.transactionTail;
        let release;
        client.transactionTail = new Promise((resolve) => {
          release = resolve;
        });
        await previous;

        try {
          let retriesRemaining = client.callbackRetries;
          while (true) {
            session.transactionStates = new Map(
              client.collections.map((collection) => [
                collection,
                collection.createTransactionState(),
              ]),
            );
            client.activeSession = session;
            client.callbackAttempts += 1;

            try {
              if (client.beforeCallbackAttempt) {
                await client.beforeCallbackAttempt(client.callbackAttempts);
              }
              const result = await client.transactionContext.run(session, operation);
              if (retriesRemaining > 0) {
                retriesRemaining -= 1;
                client.activeSession = null;
                await client.onCallbackRetry?.(client.callbackAttempts);
                continue;
              }
              if (client.failAfterCallbackWith) {
                throw client.failAfterCallbackWith;
              }

              client.activeSession = null;
              client.commitAttempts += 1;
              if (client.failCommitWith) throw client.failCommitWith;
              for (const collection of client.collections) {
                collection.commitTransactionState(
                  session.transactionStates.get(collection),
                );
              }
              const ambiguousCommitError = client.ambiguousCommitWith;
              if (ambiguousCommitError) {
                await client.afterAmbiguousCommit?.();
                throw ambiguousCommitError;
              }
              return result;
            } finally {
              client.activeSession = null;
            }
          }
        } finally {
          session.transactionStates = null;
          release();
        }
      },
      async endSession() {
        if (client.endSessionError) throw client.endSessionError;
      },
    };
    return session;
  }
}

export function createTestClock(initial = "2026-08-23T12:00:00.000Z") {
  let current = new Date(initial).getTime();

  return {
    now: () => new Date(current),
    advance(milliseconds) {
      current += milliseconds;
    },
  };
}
