import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Recall - Customer Support Agent with Persistent Memory",
  description: "AI Support Agent powered by Hindsight Cloud memory layer. Never repeats questions.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased min-h-screen">
        {children}
      </body>
    </html>
  );
}
