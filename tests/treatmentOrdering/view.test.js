import { describe, expect, it } from "vitest";
import { applyPendingTreatmentOrders } from "@/lib/treatmentOrderView";

describe("pending treatment ordering", () => {
  it("restores both pending orders over fresh records without restoring stale content", () => {
    const records = [{ _id: "a", services: [{ _id: "one", price: 100 }, { _id: "two", price: 200 }] }, { _id: "b", services: [] }];
    const result = applyPendingTreatmentOrders(records, { main: { order: ["b", "a"] }, a: { treatmentId: "a", order: ["two", "one"] } });
    expect(result.map(t => t._id)).toEqual(["b", "a"]);
    expect(result[1].services.map(s => s._id)).toEqual(["two", "one"]);
    expect(result[1].services[0].price).toBe(200);
    expect(records[0].services[0]._id).toBe("one");
  });

  it("keeps new items and ignores deleted IDs during an offline retry", () => {
    const records = [{ _id: "a", services: [{ _id: "one" }, { _id: "new" }] }, { _id: "new-treatment", services: [] }];
    const result = applyPendingTreatmentOrders(records, { main: { order: ["deleted", "a"] }, a: { order: ["deleted-service", "one"] } });
    expect(result.map(t => t._id)).toEqual(["a", "new-treatment"]);
    expect(result[0].services.map(s => s._id)).toEqual(["one", "new"]);
  });
});
