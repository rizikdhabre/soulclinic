export async function sendTreatmentOrder(payload, key, metadata, owner) {
  const response = await fetch(key === "main"
    ? "/api/admin/treatments/reorder"
    : "/api/admin/treatments/services/reorder", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    keepalive: true,
    body: JSON.stringify({ ...payload, ...metadata, owner }),
  });
  if (!response.ok) {
    const error = new Error("Treatment order was not accepted");
    error.status = response.status;
    throw error;
  }
  return response.json();
}
