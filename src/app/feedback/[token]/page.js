import FeedbackClient from "./FeedbackClient";

export const metadata = {
  title: "ملاحظتك بعد العلاج | SoulClinic",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function FeedbackPage({ params }) {
  const { token } = await params;
  return <FeedbackClient key={token} token={token} />;
}
