import CustomerProfileClient from "@/components/admin/CustomerProfileClient";

export default async function CustomerProfilePage({ params }) {
  const { userId } = await params;
  return <CustomerProfileClient key={userId} userId={userId} />;
}
