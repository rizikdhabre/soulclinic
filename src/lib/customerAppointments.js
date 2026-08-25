import { ObjectId } from "mongodb";
import {
  getCollection as getDefaultCollection,
  getMongoClient as getDefaultMongoClient,
} from "@/lib/db";
import { isTransactionUnsupportedError } from "@/lib/mongoTransactions";
import { normalizeIsraeliPhone } from "@/lib/phone";
import { sendWhatsAppTemplate as sendDefaultWhatsAppTemplate } from "@/lib/whatsapp";

const CANONICAL_APPOINTMENT_ID = /^[0-9a-f]{24}$/;
const CANCELLATION_CLAIMS_COLLECTION = "appointmentCancellationClaims";
const CANCELLATION_RECEIPTS_COLLECTION = "appointmentCancellationReceipts";
const CANCELLATION_CLAIM_LEASE_MS = 30_000;
const CANCELLATION_CLAIM_TTL_MS = 5 * 60_000;
const CANCELLATION_RECEIPT_TTL_MS = 5 * 60_000;
const SETTLED_CLAIM_TTL_MS = 60_000;
const CLAIM_ACQUISITION_ATTEMPTS = 3;
const LOCAL_CANCELLATION_FENCES = "_customerCancellationFences";
const OWNED_CANCELLATION_ROLLBACK = "_customerCancellationRollback";
const OWNED_CANCELLATION_ROLLBACK_UPDATE =
  `appointments.$.${OWNED_CANCELLATION_ROLLBACK}`;
const ORPHAN_RECOVERY_EVIDENCE = Symbol("orphanRecoveryEvidence");
const ACTIVE_CLAIM_PHASES = new Set([
  "prepared",
  "recovering",
  "day-removing",
  "day-removed",
  "user-removing",
  "restoring",
]);
const cancellationClaimIndexes = new WeakMap();
const cancellationReceiptIndexes = new WeakMap();
const systemClock = { now: () => new Date() };

const CUSTOMER_APPOINTMENT_ERRORS = Object.freeze({
  CUSTOMER_UNAUTHORIZED: {
    status: 401,
    message: "Customer session is invalid or expired.",
  },
  INVALID_APPOINTMENT_ID: {
    status: 400,
    message: "Appointment ID is invalid.",
  },
  APPOINTMENT_NOT_FOUND: {
    status: 404,
    message: "Appointment was not found.",
  },
  CUSTOMER_CANCELLATION_FAILED: {
    status: 500,
    message: "Appointment cancellation failed.",
  },
});

export class CustomerAppointmentError extends Error {
  constructor(code) {
    const definition =
      CUSTOMER_APPOINTMENT_ERRORS[code] ??
      CUSTOMER_APPOINTMENT_ERRORS.CUSTOMER_CANCELLATION_FAILED;
    super(definition.message);
    this.name = "CustomerAppointmentError";
    this.code = CUSTOMER_APPOINTMENT_ERRORS[code]
      ? code
      : "CUSTOMER_CANCELLATION_FAILED";
    this.status = definition.status;
  }
}

function customerAppointmentError(code) {
  return new CustomerAppointmentError(code);
}

function customerUnauthorized() {
  return customerAppointmentError("CUSTOMER_UNAUTHORIZED");
}

function normalizedText(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function publicAppointmentId(value) {
  try {
    if (!ObjectId.isValid(value)) return null;
    return new ObjectId(value).toHexString();
  } catch {
    return null;
  }
}

function publicAppointment(stored) {
  const appointment = {};
  const id = publicAppointmentId(stored._id);
  const date = normalizedText(stored.date);
  const time = normalizedText(stored.time);

  if (id) appointment._id = id;
  if (date) appointment.date = date;
  if (time) appointment.time = time;
  if (typeof stored.price === "number" && Number.isFinite(stored.price)) {
    appointment.price = stored.price;
  }
  if (typeof stored.attended === "boolean") {
    appointment.attended = stored.attended;
  }

  return appointment;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export async function getCustomerAppointments(phone, deps = {}) {
  if (
    typeof phone !== "string" ||
    normalizeIsraeliPhone(phone) !== phone
  ) {
    throw customerUnauthorized();
  }

  const getCollection = deps.getCollection ?? getDefaultCollection;
  const users = await getCollection("usersData");
  const user = await users.findOne(
    { phone },
    { projection: { _id: 0, appointments: 1 } },
  );

  if (!Array.isArray(user?.appointments)) return [];

  return user.appointments
    .map((stored, index) => ({
      appointment:
        stored && typeof stored === "object" && !Array.isArray(stored)
          ? publicAppointment(stored)
          : {},
      index,
    }))
    .sort((left, right) => {
      const byDate = compareText(
        left.appointment.date ?? "",
        right.appointment.date ?? "",
      );
      if (byDate) return byDate;

      const byTime = compareText(
        left.appointment.time ?? "",
        right.appointment.time ?? "",
      );
      return byTime || left.index - right.index;
    })
    .map(({ appointment }) => appointment);
}

function cancellationFailed() {
  return customerAppointmentError("CUSTOMER_CANCELLATION_FAILED");
}

function safeCancellationError(error) {
  if (
    error instanceof CustomerAppointmentError ||
    (CUSTOMER_APPOINTMENT_ERRORS[error?.code] &&
      CUSTOMER_APPOINTMENT_ERRORS[error.code].status === error?.status)
  ) {
    return error;
  }
  return cancellationFailed();
}

function isAppointmentNotFound(error) {
  return error?.code === "APPOINTMENT_NOT_FOUND" && error?.status === 404;
}

function appointmentObjectId(value) {
  if (
    typeof value !== "string" ||
    !CANONICAL_APPOINTMENT_ID.test(value)
  ) {
    throw customerAppointmentError("INVALID_APPOINTMENT_ID");
  }
  return new ObjectId(value);
}

function idsEqual(left, right) {
  if (left === right) return true;
  if (typeof left?.equals === "function") return left.equals(right);
  if (typeof right?.equals === "function") return right.equals(left);
  return false;
}

function requiredStoredText(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function transactionOptions(projection, session) {
  return session ? { projection, session } : { projection };
}

async function readOwnedAppointment({
  users,
  phone,
  appointmentId,
  session,
}) {
  const filter = {
    phone,
    "appointments._id": appointmentId,
  };
  const user = await users.findOne(
    filter,
    transactionOptions(
      {
        _id: 0,
        firstName: 1,
        lastName: 1,
        "appointments.$": 1,
      },
      session,
    ),
  );
  const appointment = user?.appointments?.find((candidate) =>
    idsEqual(candidate?._id, appointmentId),
  );

  if (!appointment) {
    throw customerAppointmentError("APPOINTMENT_NOT_FOUND");
  }

  const date = requiredStoredText(appointment.date);
  const time = requiredStoredText(appointment.time);
  if (!date || !time) throw cancellationFailed();

  const title = normalizedText(appointment.title);
  const fullName = [
    normalizedText(user.firstName),
    normalizedText(user.lastName),
  ]
    .filter(Boolean)
    .join(" ");

  return { date, time, title, fullName };
}

function provesRemoval(result) {
  return result?.matchedCount === 1 && result?.modifiedCount === 1;
}

function targetMutationFilter(filter, localFence) {
  if (!localFence) return filter;
  return { ...filter, [localFence.path]: localFence.marker };
}

async function pullUserAppointment({
  users,
  phone,
  appointmentId,
  date,
  time,
  session,
  localFence,
  localRollback,
}) {
  const appointmentFilter = localRollback
    ? {
        appointments: {
          $elemMatch: {
            _id: appointmentId,
            [OWNED_CANCELLATION_ROLLBACK]: localRollback.record,
          },
        },
      }
    : { "appointments._id": appointmentId };
  return users.updateOne(
    targetMutationFilter(
      { phone, ...appointmentFilter },
      localFence,
    ),
    {
      $pull: {
        appointments: { _id: appointmentId },
        notes: { date, time },
      },
    },
    ...(session ? [{ session }] : []),
  );
}

async function pullDayAppointment({
  appointments,
  appointmentId,
  date,
  session,
  localFence,
}) {
  return appointments.updateOne(
    targetMutationFilter(
      { date, "appointments._id": appointmentId },
      localFence,
    ),
    { $pull: { appointments: { _id: appointmentId } } },
    ...(session ? [{ session }] : []),
  );
}

function ensureCancellationReceiptIndexes(receipts) {
  if (!cancellationReceiptIndexes.has(receipts)) {
    cancellationReceiptIndexes.set(
      receipts,
      Promise.all([
        receipts.createIndex(
          { appointmentId: 1 },
          {
            unique: true,
            name: "customer_cancellation_receipt_unique_appointment",
          },
        ),
        receipts.createIndex(
          { expiresAt: 1 },
          {
            expireAfterSeconds: 0,
            name: "customer_cancellation_receipt_expiresAt_ttl",
          },
        ),
      ]),
    );
  }
  return cancellationReceiptIndexes.get(receipts);
}

function buildCancellationReceipt({
  operationId,
  appointmentId,
  phone,
  notificationData,
  now,
}) {
  if (!canonicalStoredId(operationId)) throw cancellationFailed();
  return {
    _id: operationId,
    appointmentId,
    operationId,
    phone,
    notification: {
      date: notificationData.date,
      time: notificationData.time,
      title: notificationData.title,
      fullName: notificationData.fullName,
    },
    notificationStatus: "pending",
    notificationClaimId: null,
    notificationClaimedAt: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + CANCELLATION_RECEIPT_TTL_MS),
  };
}

function cancellationReceiptIdentity(receipt) {
  return {
    _id: receipt._id,
    appointmentId: receipt.appointmentId,
    operationId: receipt.operationId,
    phone: receipt.phone,
  };
}

function exactReceiptCoreMatches(receipt, expected) {
  return (
    receipt &&
    idsEqual(receipt._id, expected._id) &&
    idsEqual(receipt.appointmentId, expected.appointmentId) &&
    idsEqual(receipt.operationId, expected.operationId) &&
    receipt.phone === expected.phone &&
    storedValuesEqual(receipt.notification, expected.notification) &&
    storedValuesEqual(receipt.createdAt, expected.createdAt) &&
    storedValuesEqual(receipt.expiresAt, expected.expiresAt)
  );
}

function exactPendingReceiptMatches(receipt, expected) {
  return (
    exactReceiptCoreMatches(receipt, expected) &&
    receipt.notificationStatus === "pending" &&
    receipt.notificationClaimId === null &&
    receipt.notificationClaimedAt === null &&
    storedValuesEqual(receipt.updatedAt, expected.updatedAt)
  );
}

function exactClaimedReceiptMatches(receipt, expected, claimedAt) {
  return (
    exactReceiptCoreMatches(receipt, expected) &&
    receipt.notificationStatus === "claimed" &&
    idsEqual(receipt.notificationClaimId, expected.operationId) &&
    storedValuesEqual(receipt.notificationClaimedAt, claimedAt) &&
    storedValuesEqual(receipt.updatedAt, claimedAt)
  );
}

async function claimCancellationNotification({ receipts, receipt, clock }) {
  const claimedAt = cancellationNow(clock);
  if (
    !(receipt.expiresAt instanceof Date) ||
    receipt.expiresAt <= claimedAt ||
    !exactPendingReceiptMatches(receipt, receipt)
  ) {
    return false;
  }

  const filter = {
    ...cancellationReceiptIdentity(receipt),
    notification: receipt.notification,
    notificationStatus: "pending",
    notificationClaimId: null,
    notificationClaimedAt: null,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    expiresAt: receipt.expiresAt,
  };
  let claimed = null;
  try {
    claimed = await receipts.findOneAndUpdate(
      filter,
      {
        $set: {
          notificationStatus: "claimed",
          notificationClaimId: receipt.operationId,
          notificationClaimedAt: claimedAt,
          updatedAt: claimedAt,
        },
      },
      { returnDocument: "after" },
    );
  } catch {
    // Exact read-back below can prove only this operation's applied claim.
  }

  if (exactClaimedReceiptMatches(claimed, receipt, claimedAt)) return true;

  try {
    const observed = await receipts.findOne(cancellationReceiptIdentity(receipt));
    return exactClaimedReceiptMatches(observed, receipt, claimedAt);
  } catch {
    return false;
  }
}

async function cancelInTransaction({
  client,
  users,
  appointments,
  getCollection,
  phone,
  appointmentId,
  operationId,
  clock,
}) {
  let session;
  let receipts;
  let notificationData = null;
  let candidateNotificationData = null;
  let candidateReceipt = null;
  let transactionError = null;
  let sessionCleanupError = null;
  let transactionWritesCompleted = false;
  let commitConfirmed = false;

  try {
    session = client.startSession();
    await session.withTransaction(async () => {
      receipts ??= await getCollection(CANCELLATION_RECEIPTS_COLLECTION);
      await ensureCancellationReceiptIndexes(receipts);
      notificationData = null;
      candidateNotificationData = null;
      candidateReceipt = null;
      transactionWritesCompleted = false;
      const owned = await readOwnedAppointment({
        users,
        phone,
        appointmentId,
        session,
      });
      candidateNotificationData = owned;
      const userResult = await pullUserAppointment({
        users,
        phone,
        appointmentId,
        date: owned.date,
        time: owned.time,
        session,
      });
      if (!provesRemoval(userResult)) throw cancellationFailed();

      const dayResult = await pullDayAppointment({
        appointments,
        appointmentId,
        date: owned.date,
        session,
      });
      if (!provesRemoval(dayResult)) throw cancellationFailed();

      transactionWritesCompleted = true;
      const now = cancellationNow(clock);
      candidateReceipt = buildCancellationReceipt({
        operationId,
        appointmentId,
        phone,
        notificationData: owned,
        now,
      });
      const inserted = await receipts.insertOne(candidateReceipt, { session });
      if (
        inserted?.acknowledged !== true ||
        !idsEqual(inserted.insertedId, operationId)
      ) {
        throw cancellationFailed();
      }
      notificationData = owned;
    });
    commitConfirmed = true;
  } catch (error) {
    transactionError = error;
  }

  if (session) {
    try {
      await session.endSession();
    } catch (cleanupError) {
      sessionCleanupError = cleanupError;
    }
  }

  if (commitConfirmed) {
    if (!notificationData || !candidateReceipt) throw cancellationFailed();
    return { notificationData, receipt: candidateReceipt, receipts };
  }

  if (
    transactionError &&
    transactionWritesCompleted &&
    candidateNotificationData &&
    candidateReceipt
  ) {
    let durableReceipt = null;
    try {
      const observed = await receipts.findOne(
        cancellationReceiptIdentity(candidateReceipt),
      );
      const freshNow = cancellationNow(clock);
      if (
        exactPendingReceiptMatches(observed, candidateReceipt) &&
        observed.expiresAt > freshNow
      ) {
        durableReceipt = observed;
      }
    } catch {
      durableReceipt = null;
    }
    if (durableReceipt) {
      return {
        notificationData: candidateNotificationData,
        receipt: durableReceipt,
        receipts,
      };
    }
    throw cancellationFailed();
  }

  if (transactionError) throw transactionError;
  if (sessionCleanupError) throw sessionCleanupError;
  throw cancellationFailed();
}

async function captureDayAppointment({
  appointments,
  appointmentId,
  date,
}) {
  const day = await appointments.findOne(
    { date, "appointments._id": appointmentId },
    { projection: { _id: 0, "appointments.$": 1 } },
  );
  const appointment = day?.appointments?.find((candidate) =>
    idsEqual(candidate?._id, appointmentId),
  );
  return appointment ?? null;
}

function storedValuesEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.getTime() === right.getTime()
    );
  }
  if (
    typeof left?.toHexString === "function" ||
    typeof right?.toHexString === "function"
  ) {
    return idsEqual(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => storedValuesEqual(value, right[index]))
    );
  }
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && storedValuesEqual(left[key], right[key]),
    )
  );
}

async function ownedAppointmentStillExists({ users, phone, appointmentId }) {
  return Boolean(
    await users.findOne(
      { phone, "appointments._id": appointmentId },
      { projection: { _id: 1 } },
    ),
  );
}

function ensureCancellationClaimIndexes(claims) {
  if (!cancellationClaimIndexes.has(claims)) {
    cancellationClaimIndexes.set(
      claims,
      Promise.all([
        claims.createIndex(
          { appointmentId: 1 },
          {
            unique: true,
            name: "customer_cancellation_claim_unique_appointment",
          },
        ),
        claims.createIndex(
          { expiresAt: 1 },
          {
            expireAfterSeconds: 0,
            name: "customer_cancellation_claim_expiresAt_ttl",
          },
        ),
      ]),
    );
  }
  return cancellationClaimIndexes.get(claims);
}

function cancellationNow(clock) {
  const now = new Date(clock.now());
  if (!Number.isFinite(now.getTime())) throw cancellationFailed();
  return now;
}

function activeClaimExpiry(now) {
  return new Date(now.getTime() + CANCELLATION_CLAIM_TTL_MS);
}

function claimLeaseExpiry(now) {
  return new Date(now.getTime() + CANCELLATION_CLAIM_LEASE_MS);
}

function localFencePath(appointmentId) {
  const canonicalId = appointmentId?.toHexString?.();
  if (!CANONICAL_APPOINTMENT_ID.test(canonicalId)) throw cancellationFailed();
  return `${LOCAL_CANCELLATION_FENCES}.${canonicalId}`;
}

function localFenceForClaim(claim, appointmentId) {
  if (!(claim?.expiresAt instanceof Date)) return null;
  return {
    path: localFencePath(appointmentId),
    marker: {
      claimId: claim._id,
      ownerId: claim.ownerId,
      fence: claim.fence,
      expiresAt: claim.expiresAt,
    },
  };
}

function localRollbackForClaim(claim, appointmentId) {
  if (
    !claim?.daySnapshot ||
    !idsEqual(claim.daySnapshot._id, appointmentId)
  ) {
    return null;
  }
  return {
    field: OWNED_CANCELLATION_ROLLBACK,
    updatePath: OWNED_CANCELLATION_ROLLBACK_UPDATE,
    record: {
      claimId: claim._id,
      ownerId: claim.ownerId,
      fence: claim.fence,
      snapshot: claim.daySnapshot,
    },
  };
}

function localEvidenceForClaim(claim, appointmentId) {
  const localFence = localFenceForClaim(claim, appointmentId);
  const rollback = localRollbackForClaim(claim, appointmentId);
  if (!localFence || !rollback) return null;
  return { ...localFence, rollback };
}

function localFenceTargets({
  users,
  appointments,
  phone,
  date,
  appointmentId,
}) {
  return [
    {
      kind: "user",
      collection: users,
      baseFilter: { phone },
      appointmentFilter: { "appointments._id": appointmentId },
    },
    {
      kind: "day",
      collection: appointments,
      baseFilter: { date },
      appointmentFilter: { "appointments._id": appointmentId },
    },
  ];
}

async function targetHasLocalFence(target, localFence) {
  return Boolean(
    await target.collection.findOne(
      { ...target.baseFilter, [localFence.path]: localFence.marker },
      { projection: { _id: 1 } },
    ),
  );
}

async function targetHasAnyLocalFence(target, path) {
  return Boolean(
    await target.collection.findOne(
      { ...target.baseFilter, [path]: { $exists: true } },
      { projection: { _id: 1 } },
    ),
  );
}

async function readTargetLocalFence(target, path) {
  const document = await target.collection.findOne(
    { ...target.baseFilter, [path]: { $exists: true } },
    { projection: { _id: 0, [path]: 1 } },
  );
  return storedPathValue(document, path);
}

function validStoredLocalFence(marker) {
  return Boolean(
    marker &&
      canonicalStoredId(marker.claimId) &&
      canonicalStoredId(marker.ownerId) &&
      Number.isInteger(marker.fence) &&
      marker.fence >= 1 &&
      marker.expiresAt instanceof Date,
  );
}

function validTerminalOrphanClaim(claim, phone, appointmentId, now) {
  const terminalLineage =
    (claim?.phase === "user-removing" && claim.recoveryPhase === undefined) ||
    (claim?.phase === "recovering" &&
      claim.recoveryPhase === "user-removing");
  const snapshot = claim?.daySnapshot;

  return Boolean(
    claim &&
      idsEqual(claim.appointmentId, appointmentId) &&
      canonicalStoredId(claim._id) &&
      canonicalStoredId(claim.ownerId) &&
      Number.isSafeInteger(claim.fence) &&
      claim.fence >= 1 &&
      claim.status === "active" &&
      terminalLineage &&
      requiredStoredText(claim.date) &&
      claim.leaseExpiresAt instanceof Date &&
      Number.isFinite(claim.leaseExpiresAt.getTime()) &&
      claim.leaseExpiresAt <= now &&
      claim.expiresAt instanceof Date &&
      Number.isFinite(claim.expiresAt.getTime()) &&
      snapshot &&
      typeof snapshot === "object" &&
      !Array.isArray(snapshot) &&
      idsEqual(snapshot._id, appointmentId) &&
      snapshot.phone === phone &&
      requiredStoredText(snapshot.time)
  );
}

function localFenceIdentityFilter(localFence) {
  return {
    [`${localFence.path}.claimId`]: localFence.marker.claimId,
    [`${localFence.path}.ownerId`]: localFence.marker.ownerId,
    [`${localFence.path}.fence`]: localFence.marker.fence,
  };
}

async function tryLocalFenceWrite(
  target,
  filter,
  localFence,
) {
  try {
    await target.collection.updateOne(
      filter,
      { $set: { [localFence.path]: localFence.marker } },
    );
  } catch {
    // A fresh exact marker read resolves a lost update acknowledgement.
  }

  try {
    return await targetHasLocalFence(target, localFence);
  } catch {
    return false;
  }
}

async function installTargetLocalFence({
  target,
  currentFence,
  previousFence,
  requiredObservedFence,
  takeover,
  allowExpired,
  now,
}) {
  try {
    if (await targetHasLocalFence(target, currentFence)) {
      return true;
    }
  } catch {
    return false;
  }

  if (requiredObservedFence) {
    return tryLocalFenceWrite(
      target,
      {
        ...target.baseFilter,
        [currentFence.path]: requiredObservedFence,
      },
      currentFence,
    );
  }

  if (previousFence) {
    const replaced = await tryLocalFenceWrite(
      target,
      {
        ...target.baseFilter,
        [previousFence.path]: previousFence.marker,
      },
      currentFence,
    );
    if (replaced) return true;

    const identityReplaced = await tryLocalFenceWrite(
      target,
      {
        ...target.baseFilter,
        ...localFenceIdentityFilter(previousFence),
      },
      currentFence,
    );
    if (identityReplaced) return true;
  }

  const installed = await tryLocalFenceWrite(
    target,
    {
      ...target.baseFilter,
      [currentFence.path]: { $exists: false },
    },
    currentFence,
  );
  if (installed) return true;

  let observed;
  try {
    observed = await readTargetLocalFence(target, currentFence.path);
  } catch {
    return false;
  }
  if (!validStoredLocalFence(observed)) return false;

  const sameLineageLowerFence = Boolean(
    takeover &&
      idsEqual(observed.claimId, currentFence.marker.claimId) &&
      observed.fence < currentFence.marker.fence,
  );
  const replaceExpired = Boolean(
    allowExpired && observed.expiresAt <= now,
  );
  if (!sameLineageLowerFence && !replaceExpired) return false;

  return tryLocalFenceWrite(
    target,
    {
      ...target.baseFilter,
      ...(sameLineageLowerFence ? {} : target.appointmentFilter),
      [currentFence.path]: observed,
    },
    currentFence,
  );
}

async function synchronizeLocalFences({
  users,
  appointments,
  phone,
  date,
  appointmentId,
  currentClaim,
  previousClaim,
  clock,
}) {
  const currentFence = localFenceForClaim(currentClaim, appointmentId);
  const currentRollback = localRollbackForClaim(currentClaim, appointmentId);
  if (!currentFence || !currentRollback) return null;
  const previousFence = previousClaim
    ? localFenceForClaim(previousClaim, appointmentId)
    : null;
  const takeover = Boolean(
    previousClaim &&
      idsEqual(previousClaim._id, currentClaim._id) &&
      currentClaim.fence > previousClaim.fence,
  );
  const targets = localFenceTargets({
    users,
    appointments,
    phone,
    date,
    appointmentId,
  });
  const now = cancellationNow(clock);
  const orphanEvidence =
    previousClaim?.[ORPHAN_RECOVERY_EVIDENCE] ?? null;

  for (const target of targets) {
    const installed = await installTargetLocalFence({
      target,
      currentFence,
      previousFence,
      requiredObservedFence:
        orphanEvidence?.[
          target.kind === "user" ? "userFence" : "dayFence"
        ] ?? null,
      takeover,
      allowExpired: !previousClaim,
      now,
    });
    if (!installed) return null;
  }
  return { ...currentFence, rollback: currentRollback };
}

function ownedRollbackElementMatch(appointmentId, expected) {
  return {
    appointments: {
      $elemMatch: {
        _id: appointmentId,
        [OWNED_CANCELLATION_ROLLBACK]: expected,
      },
    },
  };
}

async function readOwnedRollbackEvidence({
  users,
  phone,
  appointmentId,
  localFence,
  expected = { $exists: true },
}) {
  const user = await users.findOne(
    {
      phone,
      [localFence.path]: localFence.marker,
      ...ownedRollbackElementMatch(appointmentId, expected),
    },
    { projection: { _id: 0, "appointments.$": 1 } },
  );
  const appointment = user?.appointments?.find((candidate) =>
    idsEqual(candidate?._id, appointmentId),
  );
  return appointment?.[OWNED_CANCELLATION_ROLLBACK];
}

async function hasExactOwnedRollbackEvidence({
  users,
  phone,
  appointmentId,
  localFence,
  localRollback,
}) {
  const observed = await readOwnedRollbackEvidence({
    users,
    phone,
    appointmentId,
    localFence,
    expected: localRollback.record,
  });
  return storedValuesEqual(observed, localRollback.record);
}

async function tryOwnedRollbackWrite({
  users,
  filter,
  phone,
  appointmentId,
  localFence,
  localRollback,
}) {
  try {
    await users.updateOne(
      filter,
      { $set: { [localRollback.updatePath]: localRollback.record } },
    );
  } catch {
    // A fresh exact appointment read resolves a lost acknowledgement.
  }

  try {
    return await hasExactOwnedRollbackEvidence({
      users,
      phone,
      appointmentId,
      localFence,
      localRollback,
    });
  } catch {
    return false;
  }
}

function validOwnedRollbackRecord(record, claim, appointmentId) {
  return Boolean(
    record &&
      Object.keys(record).sort().join(",") ===
        "claimId,fence,ownerId,snapshot" &&
      canonicalStoredId(record.claimId) &&
      canonicalStoredId(record.ownerId) &&
      Number.isInteger(record.fence) &&
      record.fence >= 1 &&
      record.snapshot &&
      idsEqual(record.snapshot._id, appointmentId) &&
      storedValuesEqual(record.snapshot, claim.daySnapshot),
  );
}

async function synchronizeOwnedRollbackEvidence({
  users,
  phone,
  appointmentId,
  currentClaim,
  previousClaim,
  localFence,
}) {
  const currentRollback = localFence.rollback;
  if (!currentRollback) return false;

  try {
    if (
      await hasExactOwnedRollbackEvidence({
        users,
        phone,
        appointmentId,
        localFence,
        localRollback: currentRollback,
      })
    ) {
      return true;
    }
  } catch {
    return false;
  }

  const requiredObservedRollback =
    previousClaim?.[ORPHAN_RECOVERY_EVIDENCE]?.rollback ?? null;
  if (requiredObservedRollback) {
    return tryOwnedRollbackWrite({
      users,
      filter: {
        phone,
        [localFence.path]: localFence.marker,
        ...ownedRollbackElementMatch(
          appointmentId,
          requiredObservedRollback,
        ),
      },
      phone,
      appointmentId,
      localFence,
      localRollback: currentRollback,
    });
  }

  const previousRollback = previousClaim
    ? localRollbackForClaim(previousClaim, appointmentId)
    : null;
  if (previousRollback) {
    const replaced = await tryOwnedRollbackWrite({
      users,
      filter: {
        phone,
        [localFence.path]: localFence.marker,
        ...ownedRollbackElementMatch(
          appointmentId,
          previousRollback.record,
        ),
      },
      phone,
      appointmentId,
      localFence,
      localRollback: currentRollback,
    });
    if (replaced) return true;
  }

  let observed;
  try {
    observed = await readOwnedRollbackEvidence({
      users,
      phone,
      appointmentId,
      localFence,
    });
  } catch {
    return false;
  }
  if (observed !== undefined) {
    const sameLineageLowerFence = Boolean(
      validOwnedRollbackRecord(observed, currentClaim, appointmentId) &&
        idsEqual(observed.claimId, currentClaim._id) &&
        observed.fence < currentClaim.fence,
    );
    if (!sameLineageLowerFence) return false;
    return tryOwnedRollbackWrite({
      users,
      filter: {
        phone,
        [localFence.path]: localFence.marker,
        ...ownedRollbackElementMatch(appointmentId, observed),
      },
      phone,
      appointmentId,
      localFence,
      localRollback: currentRollback,
    });
  }

  return tryOwnedRollbackWrite({
    users,
    filter: {
      phone,
      [localFence.path]: localFence.marker,
      ...ownedRollbackElementMatch(appointmentId, { $exists: false }),
    },
    phone,
    appointmentId,
    localFence,
    localRollback: currentRollback,
  });
}

async function readAnyOwnedRollback({ users, phone, appointmentId }) {
  const user = await users.findOne(
    { phone, "appointments._id": appointmentId },
    { projection: { _id: 0, "appointments.$": 1 } },
  );
  const appointment = user?.appointments?.find((candidate) =>
    idsEqual(candidate?._id, appointmentId),
  );
  return appointment?.[OWNED_CANCELLATION_ROLLBACK];
}

async function cleanupOwnedRollbackEvidence({
  users,
  phone,
  appointmentId,
  localFence,
}) {
  const localRollback = localFence.rollback;
  if (!localRollback) return false;

  try {
    await users.updateOne(
      {
        phone,
        [localFence.path]: localFence.marker,
        ...ownedRollbackElementMatch(
          appointmentId,
          localRollback.record,
        ),
      },
      { $unset: { [localRollback.updatePath]: "" } },
    );
  } catch {
    // The exact read below distinguishes cleanup from successor evidence.
  }

  try {
    return (await readAnyOwnedRollback({ users, phone, appointmentId })) ===
      undefined;
  } catch {
    return false;
  }
}

async function cleanupTargetLocalFence(target, localFence) {
  const cleanupFilter = {
    ...target.baseFilter,
    [localFence.path]: localFence.marker,
  };

  try {
    await target.collection.updateOne(
      cleanupFilter,
      { $unset: { [localFence.path]: "" } },
    );
  } catch {
    // Exact/any-marker reads below distinguish cleanup from a successor.
  }

  try {
    if (await targetHasLocalFence(target, localFence)) return false;
    if (await targetHasAnyLocalFence(target, localFence.path)) return false;

    await target.collection.updateOne(
      { ...target.baseFilter, [LOCAL_CANCELLATION_FENCES]: {} },
      { $unset: { [LOCAL_CANCELLATION_FENCES]: "" } },
    );
    if (
      await target.collection.findOne(
        { ...target.baseFilter, [LOCAL_CANCELLATION_FENCES]: {} },
        { projection: { _id: 1 } },
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function cleanupLocalFences({
  users,
  appointments,
  phone,
  date,
  appointmentId,
  localFence,
}) {
  const rollbackCleaned = await cleanupOwnedRollbackEvidence({
    users,
    phone,
    appointmentId,
    localFence,
  });
  if (!rollbackCleaned) return false;

  const targets = localFenceTargets({
    users,
    appointments,
    phone,
    date,
    appointmentId,
  });
  let cleaned = true;
  for (const target of targets) {
    cleaned = (await cleanupTargetLocalFence(target, localFence)) && cleaned;
  }
  if (!cleaned) return false;

  try {
    for (const target of targets) {
      if (await targetHasAnyLocalFence(target, localFence.path)) return false;
    }
    return (await readAnyOwnedRollback({ users, phone, appointmentId })) ===
      undefined;
  } catch {
    return false;
  }
}

function claimIdentityFilter(claim) {
  return {
    _id: claim._id,
    appointmentId: claim.appointmentId,
    ownerId: claim.ownerId,
    fence: claim.fence,
    status: "active",
  };
}

function activeClaimMatches(candidate, claim, phase, now) {
  return Boolean(
    candidate &&
      idsEqual(candidate._id, claim._id) &&
      idsEqual(candidate.appointmentId, claim.appointmentId) &&
      idsEqual(candidate.ownerId, claim.ownerId) &&
      candidate.fence === claim.fence &&
      candidate.status === "active" &&
      candidate.phase === phase &&
      candidate.leaseExpiresAt instanceof Date &&
      candidate.leaseExpiresAt > now,
  );
}

function validClaimSnapshot(claim, owned, appointmentId) {
  return Boolean(
    claim?.date === owned.date &&
      claim.daySnapshot &&
      idsEqual(claim.daySnapshot._id, appointmentId),
  );
}

async function readOwnedActiveClaim({ claims, claim, phase, clock }) {
  const now = cancellationNow(clock);
  const current = await claims.findOne({
    ...claimIdentityFilter(claim),
    phase,
    leaseExpiresAt: { $gt: now },
  });
  return activeClaimMatches(current, claim, phase, now) ? current : null;
}

async function targetsHaveLocalEvidence({
  users,
  appointments,
  phone,
  appointmentId,
  claim,
}) {
  const localFence = localEvidenceForClaim(claim, appointmentId);
  if (!localFence) return false;
  const targets = localFenceTargets({
    users,
    appointments,
    phone,
    date: claim.date,
    appointmentId,
  });

  try {
    for (const target of targets) {
      if (!(await targetHasLocalFence(target, localFence))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function renewExpiredOwnedClaim({
  users,
  appointments,
  claims,
  phone,
  appointmentId,
  claim,
  phase,
  clock,
}) {
  const now = cancellationNow(clock);
  let expired;
  try {
    expired = await claims.findOne({
      ...claimIdentityFilter(claim),
      phase,
      leaseExpiresAt: { $lte: now },
    });
  } catch {
    return null;
  }
  if (
    !expired ||
    !validClaimSnapshot(expired, { date: claim.date }, appointmentId) ||
    !(await targetsHaveLocalEvidence({
      users,
      appointments,
      phone,
      appointmentId,
      claim: expired,
    }))
  ) {
    return null;
  }

  const update = {
    $set: {
      leaseExpiresAt: claimLeaseExpiry(now),
      expiresAt: activeClaimExpiry(now),
      updatedAt: now,
    },
  };
  let renewed = null;
  try {
    renewed = await claims.findOneAndUpdate(
      {
        ...claimIdentityFilter(expired),
        phase,
        leaseExpiresAt: { $lte: now },
      },
      update,
      { returnDocument: "after" },
    );
  } catch {
    // Resolve a lost renewal acknowledgement by exact owner and fence.
  }

  if (!activeClaimMatches(renewed, expired, phase, now)) {
    try {
      renewed = await readOwnedActiveClaim({
        claims,
        claim: expired,
        phase,
        clock,
      });
    } catch {
      return null;
    }
  }
  if (!renewed) return null;

  const localFence = await synchronizeLocalFences({
    users,
    appointments,
    phone,
    date: renewed.date,
    appointmentId,
    currentClaim: renewed,
    previousClaim: expired,
    clock,
  });
  if (!localFence) return null;

  try {
    const current = await readOwnedActiveClaim({
      claims,
      claim: renewed,
      phase,
      clock,
    });
    if (!current) return null;
    return (await targetsHaveLocalEvidence({
      users,
      appointments,
      phone,
      appointmentId,
      claim: current,
    }))
      ? current
      : null;
  } catch {
    return null;
  }
}

async function readOrRenewOwnedClaim({
  users,
  appointments,
  claims,
  phone,
  appointmentId,
  claim,
  phase,
  clock,
}) {
  const active = await readOwnedActiveClaim({ claims, claim, phase, clock });
  if (active) return active;
  return renewExpiredOwnedClaim({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim,
    phase,
    clock,
  });
}

async function transitionClaim({
  claims,
  claim,
  fromPhase,
  toPhase,
  clock,
}) {
  const now = cancellationNow(clock);
  const filter = {
    ...claimIdentityFilter(claim),
    phase: fromPhase,
    leaseExpiresAt: { $gt: now },
  };
  const update = {
    $set: {
      phase: toPhase,
      leaseExpiresAt: claimLeaseExpiry(now),
      expiresAt: activeClaimExpiry(now),
      updatedAt: now,
    },
  };
  if (fromPhase === "recovering" && toPhase !== "recovering") {
    update.$unset = { recoveryPhase: "" };
  }

  try {
    const transitioned = await claims.findOneAndUpdate(filter, update, {
      returnDocument: "after",
    });
    if (activeClaimMatches(transitioned, claim, toPhase, now)) {
      return transitioned;
    }
  } catch {
    // Resolve a possibly acknowledged CAS with the exact owner and fence.
  }

  try {
    return await readOwnedActiveClaim({
      claims,
      claim,
      phase: toPhase,
      clock,
    });
  } catch {
    return null;
  }
}

async function transitionClaimWithLocalFences({
  users,
  appointments,
  claims,
  phone,
  appointmentId,
  claim,
  fromPhase,
  toPhase,
  clock,
}) {
  const transitioned = await transitionClaim({
    claims,
    claim,
    fromPhase,
    toPhase,
    clock,
  });
  if (!transitioned) return null;

  const expectedFence = localEvidenceForClaim(transitioned, appointmentId);
  let ownedBeforeSync = null;
  try {
    ownedBeforeSync = await readOwnedActiveClaim({
      claims,
      claim: transitioned,
      phase: toPhase,
      clock,
    });
  } catch {
    // Exact cleanup below removes any marker retained by this stale state.
  }
  if (!ownedBeforeSync) {
    if (expectedFence) {
      await cleanupLocalFences({
        users,
        appointments,
        phone,
        date: transitioned.date,
        appointmentId,
        localFence: expectedFence,
      });
    }
    return null;
  }

  const localFence = await synchronizeLocalFences({
    users,
    appointments,
    phone,
    date: transitioned.date,
    appointmentId,
    currentClaim: ownedBeforeSync,
    previousClaim: claim,
    clock,
  });
  if (!localFence) {
    if (expectedFence) {
      await cleanupLocalFences({
        users,
        appointments,
        phone,
        date: transitioned.date,
        appointmentId,
        localFence: expectedFence,
      });
    }
    return null;
  }

  let stillOwned = null;
  try {
    stillOwned = await readOwnedActiveClaim({
      claims,
      claim: transitioned,
      phase: toPhase,
      clock,
    });
  } catch {
    // The exact cleanup below prevents an unproved marker from granting access.
  }
  if (!stillOwned) {
    await cleanupLocalFences({
      users,
      appointments,
      phone,
      date: transitioned.date,
      appointmentId,
      localFence,
    });
    return null;
  }
  return { claim: stillOwned, localFence };
}

function settledClaimMatches(candidate, claim, status) {
  return Boolean(
    candidate &&
      idsEqual(candidate._id, claim._id) &&
      idsEqual(candidate.appointmentId, claim.appointmentId) &&
      candidate.fence === claim.fence &&
      candidate.status === status &&
      candidate.phase === "settled",
  );
}

async function settleClaim({ claims, claim, phase, status, clock }) {
  const now = cancellationNow(clock);
  const ttl =
    status === "completed"
      ? CANCELLATION_CLAIM_TTL_MS
      : SETTLED_CLAIM_TTL_MS;
  const filter = {
    ...claimIdentityFilter(claim),
    phase,
    leaseExpiresAt: { $gt: now },
  };
  const update = {
    $set: {
      status,
      phase: "settled",
      settledAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + ttl),
    },
    $unset: {
      ownerId: "",
      leaseExpiresAt: "",
      date: "",
      daySnapshot: "",
      recoveryPhase: "",
    },
  };

  try {
    const settled = await claims.findOneAndUpdate(filter, update, {
      returnDocument: "after",
    });
    if (settledClaimMatches(settled, claim, status)) return settled;
  } catch {
    // A fresh exact read below resolves a lost settlement acknowledgement.
  }

  try {
    const observed = await claims.findOne({
      _id: claim._id,
      appointmentId: claim.appointmentId,
      fence: claim.fence,
      status,
      phase: "settled",
    });
    return settledClaimMatches(observed, claim, status) ? observed : null;
  } catch {
    return null;
  }
}

async function deleteSettledClaim(claims, claim, status) {
  const filter = {
    _id: claim._id,
    appointmentId: claim.appointmentId,
    fence: claim.fence,
    status,
    phase: "settled",
  };
  try {
    const result = await claims.deleteOne(filter);
    if (result?.deletedCount === 1) return true;
  } catch {
    // A retained settled record is bounded by its TTL and contains no snapshot.
    return false;
  }

  try {
    return !(await claims.findOne(filter));
  } catch {
    return false;
  }
}

async function removePriorSettledClaim(claims, claim) {
  if (claim?.status !== "restored" && claim?.status !== "released") {
    return false;
  }
  return deleteSettledClaim(claims, claim, claim.status);
}

function isDuplicateClaimError(error) {
  return error?.code === 11000;
}

function storedPathValue(document, path) {
  return path
    .split(".")
    .reduce(
      (value, key) =>
        value && typeof value === "object" ? value[key] : undefined,
      document,
    );
}

function canonicalStoredId(value) {
  const canonical = value?.toHexString?.();
  return CANONICAL_APPOINTMENT_ID.test(canonical) ? canonical : null;
}

function validExpiredRecoveryFence(marker, now) {
  return Boolean(
    validStoredLocalFence(marker) &&
      Number.isSafeInteger(marker.fence) &&
      Number.isFinite(marker.expiresAt.getTime()) &&
      marker.expiresAt <= now,
  );
}

function validExpiredRecoveryRollback(rollback, appointmentId) {
  return Boolean(
    rollback &&
      Object.keys(rollback).sort().join(",") ===
        "claimId,fence,ownerId,snapshot" &&
      canonicalStoredId(rollback.claimId) &&
      canonicalStoredId(rollback.ownerId) &&
      Number.isSafeInteger(rollback.fence) &&
      rollback.fence >= 1 &&
      rollback.snapshot &&
      typeof rollback.snapshot === "object" &&
      !Array.isArray(rollback.snapshot) &&
      idsEqual(rollback.snapshot._id, appointmentId),
  );
}

function sameGenerationOwnerMatches(left, right) {
  return left.fence !== right.fence || idsEqual(left.ownerId, right.ownerId);
}

async function readExpiredLocalRecovery({
  users,
  appointments,
  phone,
  date,
  appointmentId,
  now,
}) {
  const fencePath = localFencePath(appointmentId);
  const [user, day] = await Promise.all([
    users.findOne(
      {
        phone,
        ...ownedRollbackElementMatch(appointmentId, { $exists: true }),
      },
      {
        projection: {
          _id: 0,
          [fencePath]: 1,
          "appointments.$": 1,
        },
      },
    ),
    appointments.findOne(
      { date },
      {
        projection: {
          _id: 0,
          [fencePath]: 1,
        },
      },
    ),
  ]);
  const userFence = storedPathValue(user, fencePath);
  const dayFence = storedPathValue(day, fencePath);
  const ownedAppointment = user?.appointments?.find((candidate) =>
    idsEqual(candidate?._id, appointmentId),
  );
  const rollback =
    ownedAppointment?.[OWNED_CANCELLATION_ROLLBACK];

  if (!user) return null;
  if (
    !userFence ||
    !dayFence ||
    !validExpiredRecoveryFence(userFence, now) ||
    !validExpiredRecoveryFence(dayFence, now) ||
    !validExpiredRecoveryRollback(rollback, appointmentId) ||
    !idsEqual(userFence.claimId, dayFence.claimId) ||
    !idsEqual(rollback.claimId, userFence.claimId) ||
    userFence.fence < dayFence.fence ||
    dayFence.fence < rollback.fence ||
    !sameGenerationOwnerMatches(userFence, dayFence) ||
    !sameGenerationOwnerMatches(userFence, rollback) ||
    !sameGenerationOwnerMatches(dayFence, rollback)
  ) {
    throw cancellationFailed();
  }

  const maximumFence = Math.max(
    userFence.fence,
    dayFence.fence,
    rollback.fence,
  );
  if (!Number.isSafeInteger(maximumFence + 1)) throw cancellationFailed();

  return {
    _id: userFence.claimId,
    appointmentId,
    ownerId: userFence.ownerId,
    fence: maximumFence,
    status: "active",
    phase: "user-removing",
    date,
    daySnapshot: rollback.snapshot,
    leaseExpiresAt: userFence.expiresAt,
    expiresAt: userFence.expiresAt,
    [ORPHAN_RECOVERY_EVIDENCE]: {
      userFence,
      dayFence,
      rollback,
    },
  };
}

async function acquireCancellationClaim({
  users,
  claims,
  appointments,
  phone,
  appointmentId,
  owned,
  ownerId,
  clock,
}) {
  for (let attempt = 0; attempt < CLAIM_ACQUISITION_ATTEMPTS; attempt += 1) {
    const now = cancellationNow(clock);
    const existing = await claims.findOne({ appointmentId });

    if (existing?.status === "restored" || existing?.status === "released") {
      if (!(await removePriorSettledClaim(claims, existing))) {
        throw cancellationFailed();
      }
      continue;
    }

    if (!existing) {
      const predecessor = await readExpiredLocalRecovery({
        users,
        appointments,
        phone,
        date: owned.date,
        appointmentId,
        now,
      });
      const capturedDaySnapshot = await captureDayAppointment({
        appointments,
        appointmentId,
        date: owned.date,
      });
      if (
        capturedDaySnapshot &&
        predecessor &&
        !storedValuesEqual(
          capturedDaySnapshot,
          predecessor.daySnapshot,
        )
      ) {
        throw cancellationFailed();
      }
      const daySnapshot =
        predecessor?.daySnapshot ?? capturedDaySnapshot;
      if (!daySnapshot) throw cancellationFailed();
      const recovered = Boolean(predecessor);

      const claim = recovered
        ? {
            _id: predecessor._id,
            appointmentId,
            ownerId,
            fence: predecessor.fence + 1,
            status: "active",
            phase: "recovering",
            recoveryPhase: capturedDaySnapshot
              ? "prepared"
              : "user-removing",
            date: owned.date,
            daySnapshot,
            leaseExpiresAt: claimLeaseExpiry(now),
            createdAt: now,
            updatedAt: now,
            expiresAt: activeClaimExpiry(now),
          }
        : {
            _id: ownerId,
            appointmentId,
            ownerId,
            fence: 1,
            status: "active",
            phase: "prepared",
            date: owned.date,
            daySnapshot,
            leaseExpiresAt: claimLeaseExpiry(now),
            createdAt: now,
            updatedAt: now,
            expiresAt: activeClaimExpiry(now),
          };

      try {
        await claims.insertOne(claim);
      } catch (error) {
        let observed = null;
        try {
          observed = await claims.findOne({
            _id: claim._id,
            appointmentId,
            ownerId,
            fence: claim.fence,
            status: "active",
            phase: claim.phase,
          });
        } catch {
          // The insertion cannot be attributed to this owner.
        }
        if (activeClaimMatches(observed, claim, claim.phase, now)) {
          return { claim: observed, predecessor, recovered };
        }
        if (isDuplicateClaimError(error)) {
          if (recovered) {
            try {
              await claims.findOne({
                _id: claim._id,
                appointmentId,
              });
            } catch {
              // A recovery insert loser must fail even if observation fails.
            }
            throw cancellationFailed();
          }
          continue;
        }
        throw cancellationFailed();
      }

      const observed = await readOwnedActiveClaim({
        claims,
        claim,
        phase: claim.phase,
        clock,
      });
      if (!observed) throw cancellationFailed();
      return { claim: observed, predecessor, recovered };
    }

    if (
      existing.status !== "active" ||
      !(existing.leaseExpiresAt instanceof Date) ||
      existing.leaseExpiresAt > now ||
      !Number.isInteger(existing.fence) ||
      existing.fence < 1 ||
      !existing.ownerId ||
      !ACTIVE_CLAIM_PHASES.has(existing.phase) ||
      !validClaimSnapshot(existing, owned, appointmentId)
    ) {
      throw cancellationFailed();
    }

    const takeoverFilter = {
      _id: existing._id,
      appointmentId,
      ownerId: existing.ownerId,
      fence: existing.fence,
      status: "active",
      phase: existing.phase,
      leaseExpiresAt: { $lte: now },
    };
    const takeoverUpdate = {
      $set: {
        ownerId,
        phase: "recovering",
        recoveryPhase:
          existing.phase === "recovering"
            ? existing.recoveryPhase
            : existing.phase,
        leaseExpiresAt: claimLeaseExpiry(now),
        expiresAt: activeClaimExpiry(now),
        updatedAt: now,
      },
      $inc: { fence: 1 },
    };
    let takeover = null;
    try {
      takeover = await claims.findOneAndUpdate(
        takeoverFilter,
        takeoverUpdate,
        { returnDocument: "after" },
      );
    } catch {
      try {
        takeover = await claims.findOne({
          _id: existing._id,
          appointmentId,
          ownerId,
          fence: existing.fence + 1,
          status: "active",
          phase: "recovering",
        });
      } catch {
        // The takeover cannot be attributed to this owner and fence.
      }
    }

    const expected = {
      ...existing,
      ownerId,
      fence: existing.fence + 1,
    };
    if (activeClaimMatches(takeover, expected, "recovering", now)) {
      return { claim: takeover, predecessor: existing, recovered: true };
    }
  }

  throw cancellationFailed();
}

async function restoreDayAppointment({
  appointments,
  date,
  appointmentId,
  snapshot,
  localFence,
}) {
  try {
    await appointments.updateOne(
      targetMutationFilter(
        { date, "appointments._id": { $ne: appointmentId } },
        localFence,
      ),
      { $push: { appointments: snapshot } },
    );
  } catch {
    // A fresh exact snapshot read below resolves an ambiguous restore.
  }

  try {
    const restored = await captureDayAppointment({
      appointments,
      date,
      appointmentId,
    });
    return storedValuesEqual(restored, snapshot);
  } catch {
    return false;
  }
}

async function settleAndCleanClaim({
  users,
  appointments,
  claims,
  phone,
  appointmentId,
  claim,
  phase,
  status,
  clock,
}) {
  const renewed = await transitionClaimWithLocalFences({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim,
    fromPhase: phase,
    toPhase: phase,
    clock,
  });
  if (!renewed) return false;

  const cleaned = await cleanupLocalFences({
    users,
    appointments,
    phone,
    date: renewed.claim.date,
    appointmentId,
    localFence: renewed.localFence,
  });
  if (!cleaned) return false;

  const stillOwned = await readOwnedActiveClaim({
    claims,
    claim: renewed.claim,
    phase,
    clock,
  });
  if (!stillOwned) return false;

  const settled = await settleClaim({
    claims,
    claim: stillOwned,
    phase,
    status,
    clock,
  });
  if (!settled) return false;
  if (status !== "completed") {
    await deleteSettledClaim(claims, settled, status);
  }
  return true;
}

async function releaseInitialClaimAfterMarkerFailure({
  users,
  appointments,
  claims,
  phone,
  appointmentId,
  claim,
  clock,
}) {
  const current = await readOwnedActiveClaim({
    claims,
    claim,
    phase: "prepared",
    clock,
  });
  if (!current) return false;
  const localFence = localEvidenceForClaim(current, appointmentId);
  if (!localFence) return false;

  const cleaned = await cleanupLocalFences({
    users,
    appointments,
    phone,
    date: current.date,
    appointmentId,
    localFence,
  });
  if (!cleaned) return false;

  const stillOwned = await readOwnedActiveClaim({
    claims,
    claim: current,
    phase: "prepared",
    clock,
  });
  if (!stillOwned) return false;
  const released = await settleClaim({
    claims,
    claim: stillOwned,
    phase: "prepared",
    status: "released",
    clock,
  });
  if (!released) return false;
  await deleteSettledClaim(claims, released, "released");
  return true;
}

async function restoreUnderClaim({
  users,
  claims,
  appointments,
  phone,
  appointmentId,
  claim,
  fromPhase,
  clock,
}) {
  let restoring = await transitionClaimWithLocalFences({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim,
    fromPhase,
    toPhase: "restoring",
    clock,
  });
  if (!restoring) return false;
  restoring = await transitionClaimWithLocalFences({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim: restoring.claim,
    fromPhase: "restoring",
    toPhase: "restoring",
    clock,
  });
  if (!restoring) return false;

  let rollback;
  try {
    rollback = await readOwnedRollbackEvidence({
      users,
      phone,
      appointmentId,
      localFence: restoring.localFence,
      expected: restoring.localFence.rollback.record,
    });
  } catch {
    return false;
  }
  if (
    !storedValuesEqual(
      rollback,
      restoring.localFence.rollback.record,
    )
  ) {
    return false;
  }

  const restored = await restoreDayAppointment({
    appointments,
    date: restoring.claim.date,
    appointmentId,
    snapshot: rollback.snapshot,
    localFence: restoring.localFence,
  });
  if (!restored) return false;

  const stillOwned = await readOrRenewOwnedClaim({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim: restoring.claim,
    phase: "restoring",
    clock,
  });
  if (!stillOwned) return false;
  return settleAndCleanClaim({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim: stillOwned,
    phase: "restoring",
    status: "restored",
    clock,
  });
}

async function prepareAcquiredClaim({
  users,
  appointments,
  claims,
  phone,
  appointmentId,
  owned,
  acquisition,
  clock,
}) {
  const phase = acquisition.recovered ? "recovering" : "prepared";
  let claim = await readOwnedActiveClaim({
    claims,
    claim: acquisition.claim,
    phase,
    clock,
  });
  if (!claim) throw cancellationFailed();

  let localFence = await synchronizeLocalFences({
    users,
    appointments,
    phone,
    date: claim.date,
    appointmentId,
    currentClaim: claim,
    previousClaim: acquisition.predecessor,
    clock,
  });
  if (!localFence) {
    if (!acquisition.recovered) {
      await releaseInitialClaimAfterMarkerFailure({
        users,
        appointments,
        claims,
        phone,
        appointmentId,
        claim,
        clock,
      });
    } else {
      const expectedFence = localEvidenceForClaim(claim, appointmentId);
      if (expectedFence) {
        await cleanupLocalFences({
          users,
          appointments,
          phone,
          date: claim.date,
          appointmentId,
          localFence: expectedFence,
        });
      }
    }
    throw cancellationFailed();
  }

  let synchronizedClaim = null;
  try {
    synchronizedClaim = await readOwnedActiveClaim({
      claims,
      claim,
      phase,
      clock,
    });
  } catch {
    // Cleanup below removes only this exact marker owner and fence.
  }
  if (!synchronizedClaim) {
    await cleanupLocalFences({
      users,
      appointments,
      phone,
      date: claim.date,
      appointmentId,
      localFence,
    });
    throw cancellationFailed();
  }
  claim = synchronizedClaim;

  let ownershipRemains;
  let dayCurrent;
  try {
    ownershipRemains = await ownedAppointmentStillExists({
      users,
      phone,
      appointmentId,
    });
    dayCurrent = await captureDayAppointment({
      appointments,
      appointmentId,
      date: owned.date,
    });
    claim = await readOwnedActiveClaim({ claims, claim, phase, clock });
  } catch {
    throw cancellationFailed();
  }
  if (!claim) throw cancellationFailed();

  if (!ownershipRemains) {
    if (
      phase === "recovering" &&
      claim.recoveryPhase === "user-removing" &&
      !dayCurrent
    ) {
      const completed = await settleAndCleanClaim({
        users,
        appointments,
        claims,
        phone,
        appointmentId,
        claim,
        phase: "recovering",
        status: "completed",
        clock,
      });
      if (completed) return { completed: true };
    }
    throw cancellationFailed();
  }

  const rollbackSynchronized = await synchronizeOwnedRollbackEvidence({
    users,
    phone,
    appointmentId,
    currentClaim: claim,
    previousClaim: acquisition.predecessor,
    localFence,
  });
  if (!rollbackSynchronized) {
    if (!acquisition.recovered) {
      await releaseInitialClaimAfterMarkerFailure({
        users,
        appointments,
        claims,
        phone,
        appointmentId,
        claim,
        clock,
      });
    } else {
      await cleanupLocalFences({
        users,
        appointments,
        phone,
        date: claim.date,
        appointmentId,
        localFence,
      });
    }
    throw cancellationFailed();
  }

  try {
    claim = await readOwnedActiveClaim({ claims, claim, phase, clock });
    if (
      !claim ||
      !(await hasExactOwnedRollbackEvidence({
        users,
        phone,
        appointmentId,
        localFence,
        localRollback: localFence.rollback,
      }))
    ) {
      throw cancellationFailed();
    }
    ownershipRemains = await ownedAppointmentStillExists({
      users,
      phone,
      appointmentId,
    });
    dayCurrent = await captureDayAppointment({
      appointments,
      appointmentId,
      date: owned.date,
    });
    claim = await readOwnedActiveClaim({ claims, claim, phase, clock });
  } catch {
    throw cancellationFailed();
  }
  if (!claim) throw cancellationFailed();

  if (!ownershipRemains) {
    if (
      phase === "recovering" &&
      claim.recoveryPhase === "user-removing" &&
      !dayCurrent
    ) {
      const completed = await settleAndCleanClaim({
        users,
        appointments,
        claims,
        phone,
        appointmentId,
        claim,
        phase: "recovering",
        status: "completed",
        clock,
      });
      if (completed) return { completed: true };
    }
    throw cancellationFailed();
  }

  if (!dayCurrent) {
    await restoreUnderClaim({
      users,
      claims,
      appointments,
      phone,
      appointmentId,
      claim,
      fromPhase: phase,
      clock,
    });
    throw cancellationFailed();
  }
  if (!storedValuesEqual(dayCurrent, claim.daySnapshot)) {
    throw cancellationFailed();
  }

  if (phase === "recovering") {
    if (
      !["prepared", "day-removing"].includes(claim.recoveryPhase)
    ) {
      await settleAndCleanClaim({
        users,
        appointments,
        claims,
        phone,
        appointmentId,
        claim,
        phase: "recovering",
        status: "released",
        clock,
      });
      throw cancellationFailed();
    }

    const prepared = await transitionClaimWithLocalFences({
      users,
      appointments,
      claims,
      phone,
      appointmentId,
      claim,
      fromPhase: "recovering",
      toPhase: "prepared",
      clock,
    });
    if (!prepared) throw cancellationFailed();
    claim = prepared.claim;
    localFence = prepared.localFence;
  }
  return { claim, localFence, completed: false };
}

async function reconcileDayWrite({
  users,
  appointments,
  claims,
  phone,
  appointmentId,
  owned,
  claim,
  ambiguous,
  clock,
}) {
  let current = await readOrRenewOwnedClaim({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim,
    phase: "day-removing",
    clock,
  });
  if (!current) throw cancellationFailed();

  let ownershipRemains;
  let dayCurrent;
  try {
    ownershipRemains = await ownedAppointmentStillExists({
      users,
      phone,
      appointmentId,
    });
    dayCurrent = await captureDayAppointment({
      appointments,
      appointmentId,
      date: owned.date,
    });
    current = await readOrRenewOwnedClaim({
      users,
      appointments,
      claims,
      phone,
      appointmentId,
      claim: current,
      phase: "day-removing",
      clock,
    });
  } catch {
    throw cancellationFailed();
  }
  if (!current) throw cancellationFailed();

  if (dayCurrent) {
    if (ownershipRemains && storedValuesEqual(dayCurrent, current.daySnapshot)) {
      await settleAndCleanClaim({
        users,
        appointments,
        claims,
        phone,
        appointmentId,
        claim: current,
        phase: "day-removing",
        status: "released",
        clock,
      });
    }
    throw cancellationFailed();
  }
  if (!ownershipRemains) throw cancellationFailed();

  if (ambiguous) {
    await restoreUnderClaim({
      users,
      claims,
      appointments,
      phone,
      appointmentId,
      claim: current,
      fromPhase: "day-removing",
      clock,
    });
    throw cancellationFailed();
  }

  const dayRemoved = await transitionClaimWithLocalFences({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim: current,
    fromPhase: "day-removing",
    toPhase: "day-removed",
    clock,
  });
  if (!dayRemoved) throw cancellationFailed();
  return dayRemoved.claim;
}

async function reconcileUserWrite({
  users,
  appointments,
  claims,
  phone,
  appointmentId,
  owned,
  claim,
  clock,
}) {
  let current = await readOrRenewOwnedClaim({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim,
    phase: "user-removing",
    clock,
  });
  if (!current) {
    const localFence = localEvidenceForClaim(claim, appointmentId);
    if (localFence) {
      try {
        const centralClaim = await claims.findOne({ appointmentId });
        const ownershipRemains = await ownedAppointmentStillExists({
          users,
          phone,
          appointmentId,
        });
        const dayCurrent = await captureDayAppointment({
          appointments,
          appointmentId,
          date: owned.date,
        });
        if (
          !centralClaim &&
          !ownershipRemains &&
          !dayCurrent &&
          (await targetsHaveLocalEvidence({
            users,
            appointments,
            phone,
            appointmentId,
            claim,
          }))
        ) {
          await cleanupLocalFences({
            users,
            appointments,
            phone,
            date: owned.date,
            appointmentId,
            localFence,
          });
        }
      } catch {
        // Orphan cleanup is best effort and cannot prove cancellation success.
      }
    }
    throw cancellationFailed();
  }

  let ownershipRemains;
  let dayCurrent;
  try {
    ownershipRemains = await ownedAppointmentStillExists({
      users,
      phone,
      appointmentId,
    });
    dayCurrent = await captureDayAppointment({
      appointments,
      appointmentId,
      date: owned.date,
    });
    current = await readOrRenewOwnedClaim({
      users,
      appointments,
      claims,
      phone,
      appointmentId,
      claim: current,
      phase: "user-removing",
      clock,
    });
  } catch {
    throw cancellationFailed();
  }
  if (!current) throw cancellationFailed();

  if (!ownershipRemains && !dayCurrent) {
    const completed = await settleAndCleanClaim({
      users,
      appointments,
      claims,
      phone,
      appointmentId,
      claim: current,
      phase: "user-removing",
      status: "completed",
      clock,
    });
    if (completed) return owned;
    throw cancellationFailed();
  }

  if (ownershipRemains && !dayCurrent) {
    await restoreUnderClaim({
      users,
      claims,
      appointments,
      phone,
      appointmentId,
      claim: current,
      fromPhase: "user-removing",
      clock,
    });
    throw cancellationFailed();
  }

  if (
    ownershipRemains &&
    dayCurrent &&
    storedValuesEqual(dayCurrent, current.daySnapshot)
  ) {
    await settleAndCleanClaim({
      users,
      appointments,
      claims,
      phone,
      appointmentId,
      claim: current,
      phase: "user-removing",
      status: "released",
      clock,
    });
  }
  throw cancellationFailed();
}

function orphanNotificationData(claim) {
  const snapshot = claim.daySnapshot;
  return {
    date: claim.date,
    time: snapshot.time,
    title: normalizedText(snapshot.title),
    fullName: [
      normalizedText(snapshot.firstName),
      normalizedText(snapshot.lastName),
    ]
      .filter(Boolean)
      .join(" "),
  };
}

async function takeOverTerminalOrphanClaim({
  claims,
  existing,
  appointmentId,
  ownerId,
  clock,
}) {
  const now = cancellationNow(clock);
  const leaseExpiresAt = claimLeaseExpiry(now);
  const expiresAt = activeClaimExpiry(now);
  const recoveryPhase = "user-removing";
  const filter = {
    _id: existing._id,
    appointmentId,
    ownerId: existing.ownerId,
    fence: existing.fence,
    status: "active",
    phase: existing.phase,
    recoveryPhase:
      existing.phase === "recovering"
        ? recoveryPhase
        : { $exists: false },
    date: existing.date,
    daySnapshot: existing.daySnapshot,
    leaseExpiresAt: existing.leaseExpiresAt,
    expiresAt: existing.expiresAt,
  };
  const update = {
    $set: {
      ownerId,
      phase: "recovering",
      recoveryPhase,
      leaseExpiresAt,
      expiresAt,
      updatedAt: now,
    },
    $inc: { fence: 1 },
  };
  let takeover = null;

  try {
    takeover = await claims.findOneAndUpdate(filter, update, {
      returnDocument: "after",
    });
  } catch {
    try {
      takeover = await claims.findOne({
        _id: existing._id,
        appointmentId,
        ownerId,
        fence: existing.fence + 1,
        status: "active",
        phase: "recovering",
        recoveryPhase,
        date: existing.date,
        daySnapshot: existing.daySnapshot,
        leaseExpiresAt,
        expiresAt,
      });
    } catch {
      // A post-CAS read may prove only this exact successor generation.
    }
  }

  const expected = {
    ...existing,
    ownerId,
    fence: existing.fence + 1,
  };
  if (
    !activeClaimMatches(takeover, expected, "recovering", now) ||
    takeover.recoveryPhase !== recoveryPhase ||
    takeover.date !== existing.date ||
    !storedValuesEqual(takeover.daySnapshot, existing.daySnapshot) ||
    !storedValuesEqual(takeover.leaseExpiresAt, leaseExpiresAt) ||
    !storedValuesEqual(takeover.expiresAt, expiresAt)
  ) {
    throw cancellationFailed();
  }

  return takeover;
}

async function requireCentralClaimAbsent(claims, appointmentId) {
  const central = await claims.findOne(
    { appointmentId },
    { projection: { _id: 1 } },
  );
  if (central) throw cancellationFailed();
}

async function readOnlyDayMarker({ appointments, path }) {
  const day = await appointments.findOne(
    { [path]: { $exists: true } },
    { projection: { _id: 1, date: 1, [path]: 1 } },
  );
  if (!day) return null;
  if (!canonicalStoredId(day._id)) throw cancellationFailed();

  const duplicate = await appointments.findOne(
    { _id: { $ne: day._id }, [path]: { $exists: true } },
    { projection: { _id: 1 } },
  );
  if (duplicate) throw cancellationFailed();

  const marker = storedPathValue(day, path);
  if (!marker) throw cancellationFailed();
  return { day, marker };
}

async function requireAppointmentEntriesAbsent({
  users,
  appointments,
  phone,
  appointmentId,
}) {
  const [owned, day] = await Promise.all([
    users.findOne(
      { phone, "appointments._id": appointmentId },
      { projection: { _id: 1 } },
    ),
    appointments.findOne(
      { "appointments._id": appointmentId },
      { projection: { _id: 1 } },
    ),
  ]);
  if (owned || day) throw cancellationFailed();
}

async function cleanupEmptyLocalFenceRoot(collection, baseFilter) {
  try {
    await collection.updateOne(
      { ...baseFilter, [LOCAL_CANCELLATION_FENCES]: {} },
      { $unset: { [LOCAL_CANCELLATION_FENCES]: "" } },
    );
  } catch {
    // An empty non-PII root is not a cancellation marker.
  }
}

async function cleanupExpiredOrphanMarkers({
  users,
  appointments,
  claims,
  phone,
  appointmentId,
  path,
  observedUserFence,
  clock,
}) {
  const now = cancellationNow(clock);
  if (!validExpiredRecoveryFence(observedUserFence, now)) {
    throw cancellationFailed();
  }

  await requireAppointmentEntriesAbsent({
    users,
    appointments,
    phone,
    appointmentId,
  });
  const dayEvidence = await readOnlyDayMarker({
    appointments,
    path,
  });
  if (
    dayEvidence &&
    (!validExpiredRecoveryFence(dayEvidence.marker, now) ||
      !storedValuesEqual(dayEvidence.marker, observedUserFence))
  ) {
    throw cancellationFailed();
  }

  await requireCentralClaimAbsent(claims, appointmentId);
  if (dayEvidence) {
    let dayResult;
    try {
      dayResult = await appointments.updateOne(
        {
          _id: dayEvidence.day._id,
          "appointments._id": { $ne: appointmentId },
          [path]: dayEvidence.marker,
        },
        { $unset: { [path]: "" } },
      );
    } catch {
      throw cancellationFailed();
    }
    if (!provesRemoval(dayResult)) throw cancellationFailed();

    await requireCentralClaimAbsent(claims, appointmentId);
    const remainingDayMarker = await appointments.findOne(
      { [path]: { $exists: true } },
      { projection: { _id: 1 } },
    );
    if (remainingDayMarker) throw cancellationFailed();
  }

  await requireAppointmentEntriesAbsent({
    users,
    appointments,
    phone,
    appointmentId,
  });
  await requireCentralClaimAbsent(claims, appointmentId);

  let userResult;
  try {
    userResult = await users.updateOne(
      {
        phone,
        "appointments._id": { $ne: appointmentId },
        [path]: observedUserFence,
      },
      { $unset: { [path]: "" } },
    );
  } catch {
    throw cancellationFailed();
  }
  if (!provesRemoval(userResult)) throw cancellationFailed();

  await requireCentralClaimAbsent(claims, appointmentId);
  await requireAppointmentEntriesAbsent({
    users,
    appointments,
    phone,
    appointmentId,
  });
  const [userMarker, dayMarker] = await Promise.all([
    readTargetLocalFence(
      { collection: users, baseFilter: { phone } },
      path,
    ),
    appointments.findOne(
      { [path]: { $exists: true } },
      { projection: { _id: 1 } },
    ),
  ]);
  if (userMarker !== undefined || dayMarker) throw cancellationFailed();

  await cleanupEmptyLocalFenceRoot(users, { phone });
  if (dayEvidence) {
    await cleanupEmptyLocalFenceRoot(appointments, {
      _id: dayEvidence.day._id,
    });
  }
  await requireCentralClaimAbsent(claims, appointmentId);
}

async function recoverTerminalCancellationOrphan({
  users,
  appointments,
  getCollection,
  phone,
  appointmentId,
  clock,
  claimIdFactory,
}) {
  const path = localFencePath(appointmentId);
  const userTarget = {
    collection: users,
    baseFilter: { phone },
  };
  const observedUserFence = await readTargetLocalFence(userTarget, path);
  if (observedUserFence === undefined) return null;
  if (!validStoredLocalFence(observedUserFence)) throw cancellationFailed();

  const claims = await getCollection(CANCELLATION_CLAIMS_COLLECTION);
  await ensureCancellationClaimIndexes(claims);
  const existing = await claims.findOne({ appointmentId });
  if (!existing) {
    await cleanupExpiredOrphanMarkers({
      users,
      appointments,
      claims,
      phone,
      appointmentId,
      path,
      observedUserFence,
      clock,
    });
    return null;
  }

  const now = cancellationNow(clock);
  if (!validTerminalOrphanClaim(existing, phone, appointmentId, now)) {
    throw cancellationFailed();
  }
  const expectedFence = localFenceForClaim(existing, appointmentId);
  if (
    !expectedFence ||
    !storedValuesEqual(observedUserFence, expectedFence.marker)
  ) {
    throw cancellationFailed();
  }

  const dayTarget = {
    collection: appointments,
    baseFilter: { date: existing.date },
  };
  const [observedDayFence, ownershipRemains, dayCurrent] = await Promise.all([
    readTargetLocalFence(dayTarget, path),
    ownedAppointmentStillExists({ users, phone, appointmentId }),
    captureDayAppointment({
      appointments,
      appointmentId,
      date: existing.date,
    }),
  ]);
  if (
    !validStoredLocalFence(observedDayFence) ||
    !storedValuesEqual(observedDayFence, expectedFence.marker) ||
    ownershipRemains ||
    dayCurrent
  ) {
    throw cancellationFailed();
  }

  const ownerId = claimIdFactory();
  if (!canonicalStoredId(ownerId)) throw cancellationFailed();
  const takeover = await takeOverTerminalOrphanClaim({
    claims,
    existing,
    appointmentId,
    ownerId,
    clock,
  });
  const predecessor = {
    ...existing,
    [ORPHAN_RECOVERY_EVIDENCE]: {
      userFence: observedUserFence,
      dayFence: observedDayFence,
    },
  };
  const prepared = await prepareAcquiredClaim({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    owned: { date: existing.date },
    acquisition: {
      claim: takeover,
      predecessor,
      recovered: true,
    },
    clock,
  });
  if (!prepared.completed) throw cancellationFailed();
  return orphanNotificationData(takeover);
}

async function cancelWithFallback({
  users,
  appointments,
  getCollection,
  phone,
  appointmentId,
  clock,
  claimIdFactory,
}) {
  let owned;
  try {
    owned = await readOwnedAppointment({ users, phone, appointmentId });
  } catch (error) {
    if (!isAppointmentNotFound(error)) throw error;
    const recovered = await recoverTerminalCancellationOrphan({
      users,
      appointments,
      getCollection,
      phone,
      appointmentId,
      clock,
      claimIdFactory,
    });
    if (!recovered) throw error;
    return recovered;
  }
  const claims = await getCollection(CANCELLATION_CLAIMS_COLLECTION);
  await ensureCancellationClaimIndexes(claims);
  const ownerId = claimIdFactory();
  if (!ownerId || typeof ownerId.toHexString !== "function") {
    throw cancellationFailed();
  }

  const acquisition = await acquireCancellationClaim({
    users,
    claims,
    appointments,
    phone,
    appointmentId,
    owned,
    ownerId,
    clock,
  });
  let prepared = await prepareAcquiredClaim({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    owned,
    acquisition,
    clock,
  });
  if (prepared.completed) return owned;

  let state = await transitionClaimWithLocalFences({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim: prepared.claim,
    fromPhase: "prepared",
    toPhase: "day-removing",
    clock,
  });
  if (!state) throw cancellationFailed();

  let dayResult;
  try {
    dayResult = await pullDayAppointment({
      appointments,
      appointmentId,
      date: owned.date,
      localFence: state.localFence,
    });
  } catch {
    return reconcileDayWrite({
      users,
      appointments,
      claims,
      phone,
      appointmentId,
      owned,
      claim: state.claim,
      ambiguous: true,
      clock,
    });
  }

  let claim = await reconcileDayWrite({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    owned,
    claim: state.claim,
    ambiguous: !provesRemoval(dayResult),
    clock,
  });

  state = await transitionClaimWithLocalFences({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim,
    fromPhase: "day-removed",
    toPhase: "user-removing",
    clock,
  });
  if (!state) throw cancellationFailed();
  state = await transitionClaimWithLocalFences({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    claim: state.claim,
    fromPhase: "user-removing",
    toPhase: "user-removing",
    clock,
  });
  if (!state) throw cancellationFailed();

  try {
    await pullUserAppointment({
      users,
      phone,
      appointmentId,
      date: owned.date,
      time: owned.time,
      localFence: state.localFence,
      localRollback: state.localFence.rollback,
    });
  } catch {
    // Resolve a possibly acknowledged user write under the same fence.
  }

  return reconcileUserWrite({
    users,
    appointments,
    claims,
    phone,
    appointmentId,
    owned,
    claim: state.claim,
    clock,
  });
}

async function sendCancellationNotification(notificationData, deps) {
  const sendWhatsAppTemplate =
    deps.sendWhatsAppTemplate ?? sendDefaultWhatsAppTemplate;
  const env = deps.env ?? process.env;

  try {
    await sendWhatsAppTemplate({
      to: env.TWILIO_WHATSAPP_TO,
      templateSid: env.TWILIO_TEMPLATE_CANCEL_CUSTUMER,
      variables: {
        1: "صقر",
        2: notificationData.title || "خدمة",
        3: notificationData.fullName || "غير معروف",
        4: notificationData.date,
        5: notificationData.time,
      },
    });
  } catch {
    // Cancellation is durable; provider failure must not invite a DB retry.
  }
}

export async function cancelCustomerAppointment(
  { phone, appointmentId },
  deps = {},
) {
  if (
    typeof phone !== "string" ||
    normalizeIsraeliPhone(phone) !== phone
  ) {
    throw customerUnauthorized();
  }
  const sharedId = appointmentObjectId(appointmentId);
  const getCollection = deps.getCollection ?? getDefaultCollection;
  const getMongoClient = deps.getMongoClient ?? getDefaultMongoClient;

  let users;
  let appointments;
  try {
    users = await getCollection("usersData");
    appointments = await getCollection("appointments");
  } catch {
    throw cancellationFailed();
  }

  let cancellation;
  try {
    const client = await getMongoClient();
    const operationIdFactory =
      deps.cancellationOperationIdFactory ?? (() => new ObjectId());
    const operationId = operationIdFactory();
    cancellation = await cancelInTransaction({
      client,
      users,
      appointments,
      getCollection,
      phone,
      appointmentId: sharedId,
      operationId,
      clock: deps.clock ?? systemClock,
    });
  } catch (error) {
    if (!isTransactionUnsupportedError(error)) {
      throw safeCancellationError(error);
    }

    try {
      const notificationData = await cancelWithFallback({
        users,
        appointments,
        getCollection,
        phone,
        appointmentId: sharedId,
        clock: deps.clock ?? systemClock,
        claimIdFactory: deps.claimIdFactory ?? (() => new ObjectId()),
      });
      cancellation = { notificationData, receipt: null };
    } catch (fallbackError) {
      throw safeCancellationError(fallbackError);
    }
  }

  let shouldNotify = true;
  if (cancellation.receipt) {
    shouldNotify = await claimCancellationNotification({
      receipts: cancellation.receipts,
      receipt: cancellation.receipt,
      clock: deps.clock ?? systemClock,
    });
  }
  if (shouldNotify) {
    await sendCancellationNotification(cancellation.notificationData, deps);
  }
  return { success: true };
}
