import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";
import { Providers } from "./providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Utility Optimizer CRM", template: "%s · Utility Optimizer CRM" },
  description: "Energy and Worldpay sales, renewals and compliance for Utility Optimizer Limited.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#0b6b5d" }, { media: "(prefers-color-scheme: dark)", color: "#0d1513" }] };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IE" className={inter.variable}>
      <body className="min-h-dvh font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
