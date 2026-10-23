import { getReturnReminderUnsubscribe, unsubscribeReturnReminders } from "@/lib/returnReminderPreferences";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

function failure(error) {
  const unavailable = error?.code === "RETURN_REMINDER_LINK_UNAVAILABLE";
  return Response.json({
    error: unavailable ? "RETURN_REMINDER_LINK_UNAVAILABLE" : "RETURN_REMINDER_UNSUBSCRIBE_FAILED",
  }, { status: unavailable ? 404 : 500, headers: HEADERS });
}

export async function GET(_request, context) {
  try {
    const { token } = await context.params;
    return Response.json(await getReturnReminderUnsubscribe({ token }), { headers: HEADERS });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(_request, context) {
  try {
    const { token } = await context.params;
    return Response.json(await unsubscribeReturnReminders({ token }), { headers: HEADERS });
  } catch (error) {
    return failure(error);
  }
}
