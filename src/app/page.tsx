import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";

export default async function Home() {
  const user = await getCurrentUser((await cookies()).get("rentescrow_session")?.value);
  if (!user) redirect("/login");
  redirect(user.role === "landlord" ? "/landlord" : "/tenant");
}
