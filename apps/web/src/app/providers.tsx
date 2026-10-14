"use client";

import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Toaster, toast } from "sonner";
import { ApiError } from "@/lib/api";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 20_000, refetchOnWindowFocus: true, retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2 } },
        mutationCache: new MutationCache({
          // Mutations that don't handle their own errors show a toast. Rule violations (422) are usually shown inline.
          onError: (e, _v, _c, m) => {
            if (m.meta?.silent) return;
            const err = e as ApiError;
            toast.error(err.message, { description: err.issues?.length > 1 ? err.issues.join(" • ") : undefined });
          },
        }),
      }),
  );
  return (
    <QueryClientProvider client={client}>
      {children}
      <Toaster richColors position="top-right" closeButton />
    </QueryClientProvider>
  );
}
