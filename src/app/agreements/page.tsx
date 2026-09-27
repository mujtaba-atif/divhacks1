import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AgreementsWorkspace } from "@/components/agreement-panel";
import { getCurrentUser } from "@/lib/server/auth";

export default async function AgreementsPage() {
  const user = await getCurrentUser((await cookies()).get("rentescrow_session")?.value);
  if (!user) redirect("/login");
  return <AgreementsWorkspace user={user} />;
}
