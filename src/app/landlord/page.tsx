import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import LandlordWorkspace from "@/components/landlord-workspace";
import { getCurrentUser } from "@/lib/server/auth";

export default async function LandlordPage() {
  const user = await getCurrentUser((await cookies()).get("rentescrow_session")?.value);
  if (!user) redirect("/login");
  if (user.role !== "landlord") redirect("/tenant");
  return <LandlordWorkspace user={user} />;
}
