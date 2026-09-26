import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RentEscrow NYC | Tenant Workspace",
  description: "A tenant-controlled repair case workspace. Document evidence, coordinate repairs, and approve simulated rent escrow release.",
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
