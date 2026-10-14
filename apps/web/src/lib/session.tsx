"use client";

import { useQuery } from "@tanstack/react-query";
import type { Capability, Role } from "@uo/shared";
import { createContext, type ReactNode, useContext } from "react";
import { api } from "./api";

export interface SessionUser {
  id: string;
  name: string;
  roles: Role[];
  capabilities: Capability[];
}

const SessionContext = createContext<SessionUser | null>(null);

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api.get<{ user: SessionUser }>("/auth/me").then((r) => r.user), retry: false, staleTime: 5 * 60_000 });
}

export function SessionProvider({ user, children }: { user: SessionUser; children: ReactNode }) {
  return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>;
}

export function useUser(): SessionUser {
  const u = useContext(SessionContext);
  if (!u) throw new Error("useUser outside SessionProvider");
  return u;
}

/** UI hint only; the API enforces every permission. */
export function useCan() {
  const u = useUser();
  return (cap: Capability) => u.capabilities.includes(cap);
}
