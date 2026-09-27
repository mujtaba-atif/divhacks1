import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import RentWorkspace from "@/components/rent-workspace";
import { getCurrentUser } from "@/lib/server/auth";

export default async function TenantPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const user = await getCurrentUser((await cookies()).get("rentescrow_session")?.value);
  if (!user) redirect("/login");
  if (user.role !== "tenant") redirect("/landlord");
  const { view } = await searchParams;
  return <RentWorkspace user={user} initialView={view === "contracts" ? "contracts" : "cases"} />;
}
