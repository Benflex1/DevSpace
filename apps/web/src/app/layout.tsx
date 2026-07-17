import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = { title: "DevSpace", description: "Trusted development workspaces" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
