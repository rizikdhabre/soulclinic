function ordered(records, ids) {
  if (!Array.isArray(ids)) return records;
  const positions = new Map(ids.map((id, index) => [id, index]));
  return [...records].sort((a, b) =>
    (positions.get(String(a._id)) ?? ids.length) - (positions.get(String(b._id)) ?? ids.length));
}

export function applyPendingTreatmentOrders(treatments, pending = {}) {
  return ordered(treatments, pending.main?.order).map(treatment => ({
    ...treatment,
    services: ordered(treatment.services || [], pending[treatment._id]?.order),
  }));
}
