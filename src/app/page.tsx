import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/server/auth";
import LoginForm from "@/components/login-form";

export default async function Home({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const user = await getCurrentUser((await cookies()).get("rentescrow_session")?.value);
  if (user) redirect(user.role === "landlord" ? "/landlord" : "/tenant");
  const { role } = await searchParams;
  return <LoginForm initialRole={role === "landlord" ? "landlord" : "tenant"} />;
}
