import UnsubscribeClient from "./UnsubscribeClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "إيقاف تذكيرات العودة | SoulClinic",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function UnsubscribePage({ params }) {
  const { token } = await params;
  return <UnsubscribeClient key={token} token={token} />;
}
