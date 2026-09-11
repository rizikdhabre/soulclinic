import { requestFirebaseSend } from "@/lib/otp/firebaseSend";
import { handleFirebaseOtpRequest } from "@/lib/otp/firebaseHttp";

export const runtime = "nodejs";
export function POST(request) {
  return handleFirebaseOtpRequest(request, requestFirebaseSend);
}
