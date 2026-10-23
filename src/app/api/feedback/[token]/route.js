import { getFeedbackRequest, submitAppointmentFeedback } from "@/lib/appointmentFeedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};
const ERROR_STATUS = { FEEDBACK_UNAVAILABLE: 404, ALREADY_SUBMITTED: 409, INVALID_FEEDBACK: 400 };

function failure(error) {
  const status = ERROR_STATUS[error?.code] || 500;
  return Response.json({ error: status === 500 ? "FEEDBACK_FAILED" : error.code }, { status, headers: HEADERS });
}

export async function GET(_request, context) {
  try {
    const { token } = await context.params;
    return Response.json(await getFeedbackRequest({ token }), { headers: HEADERS });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request, context) {
  let body;
  try {
    // Bound the JSON envelope as well as the eventual text field; escaped Arabic can use six bytes per character.
    if (Number(request.headers.get("content-length")) > 80_000) throw new Error("Invalid body");
    const raw = await request.text();
    if (raw.length > 80_000) throw new Error("Invalid body");
    body = JSON.parse(raw);
    if (!body || typeof body.text !== "string" || !body.text.trim() || body.text.length > 10_000) throw new Error("Invalid body");
  } catch {
    return Response.json({ error: "INVALID_FEEDBACK" }, { status: 400, headers: HEADERS });
  }
  try {
    const { token } = await context.params;
    return Response.json(await submitAppointmentFeedback({ token, text: body.text }), { headers: HEADERS });
  } catch (error) {
    return failure(error);
  }
}
