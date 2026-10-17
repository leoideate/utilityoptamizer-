"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { AppShell } from "@/components/shell";
import { BrandSplash } from "@/components/brand";
import { DeskProvider } from "@/lib/desk";
import { RealtimeProvider } from "@/lib/realtime";
import { SessionProvider, useMe } from "@/lib/session";

export default function AuthedLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();

  useEffect(() => {
    try {
      const t = localStorage.getItem("uo-theme");
      if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    } catch {
      /* storage unavailable */
    }
  }, []);

  useEffect(() => {
    if (me.isError) router.replace(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
  }, [me.isError, router]);

  // Start-up: the brand ring pulses until the session is known.
  if (!me.data) return <BrandSplash />;
  return (
    <SessionProvider user={me.data}>
      <RealtimeProvider userId={me.data.id}>
        <DeskProvider>
          <AppShell>{children}</AppShell>
        </DeskProvider>
      </RealtimeProvider>
    </SessionProvider>
  );
}
