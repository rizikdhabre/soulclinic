import { expect, it, vi, afterEach } from "vitest";
import { sendTreatmentOrder } from "@/lib/sendTreatmentOrder";
afterEach(() => vi.unstubAllGlobals());
it("hands a keepalive request to the browser immediately and waits for durable acceptance", async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({ accepted: true }) });
  vi.stubGlobal("fetch", fetch);
  await sendTreatmentOrder({ order: ["b", "a"] }, "main", { clientId: "device", sequence: 2 }, "admin");
  expect(fetch).toHaveBeenCalledWith("/api/admin/treatments/reorder", expect.objectContaining({ method: "PUT", keepalive: true, credentials: "same-origin" }));
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ order: ["b", "a"], clientId: "device", sequence: 2, owner: "admin" });
});
it("keeps a failed admission retryable by exposing the HTTP error", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  await expect(sendTreatmentOrder({ order: [] }, "main", {}, "admin")).rejects.toMatchObject({ status: 503 });
});
