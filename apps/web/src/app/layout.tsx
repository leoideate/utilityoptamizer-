import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// Material Design 3 tokens first; the brand theme in globals.css then overrides them.
import "@awc-ui/core/css/tokens.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/700.css";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "Utility Optimizer CRM", template: "%s · Utility Optimizer CRM" },
  description: "Energy and Worldpay sales, renewals and compliance for Utility Optimizer Limited.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: [{ media: "(prefers-color-scheme: light)", color: "#036b5c" }, { media: "(prefers-color-scheme: dark)", color: "#0e1513" }] };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IE">
      <body className="min-h-dvh font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
