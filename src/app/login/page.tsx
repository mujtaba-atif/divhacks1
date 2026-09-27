import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import LoginForm from "@/components/login-form";
import { getCurrentUser } from "@/lib/server/auth";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const user = await getCurrentUser((await cookies()).get("rentescrow_session")?.value);
  if (user) redirect(user.role === "landlord" ? "/landlord" : "/tenant");
  const { role } = await searchParams;
  return <LoginForm initialRole={role === "landlord" ? "landlord" : "tenant"} />;
}
