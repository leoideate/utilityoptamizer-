"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { AppShell } from "@/components/shell";
import { Skeleton } from "@/components/ui/primitives";
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

  if (!me.data) {
    return (
      <div className="flex min-h-dvh" aria-busy="true" aria-label="Loading">
        <div className="hidden w-60 border-r border-border bg-surface lg:block" />
        <div className="flex-1 space-y-4 p-6">
          <Skeleton className="h-8 w-64" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-80" />
        </div>
      </div>
    );
  }
  return (
    <SessionProvider user={me.data}>
      <RealtimeProvider userId={me.data.id}>
        <AppShell>{children}</AppShell>
      </RealtimeProvider>
    </SessionProvider>
  );
}
