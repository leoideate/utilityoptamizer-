"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useRealtimeConnected } from "./realtime";

export interface MailboxInfo {
  id: string;
  provider: "microsoft" | "google";
  address: string;
  status: "active" | "reauth_required" | "disconnected";
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface EmailSummary {
  id: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  subject: string;
  snippet: string;
  sentAt: string;
  unread: boolean;
  hasAttachments: boolean;
  opportunityId: string | null;
  customerId: string | null;
  opportunityName: string | null;
  customerName: string | null;
}

export interface EmailDetail extends EmailSummary {
  direction: "inbound" | "outbound";
  ccAddresses: string[];
  body: string;
  isOwner: boolean;
  canReply: boolean;
  mailbox: { address: string; provider: "microsoft" | "google"; ownerName: string };
}

export const PROVIDER_LABELS = { microsoft: "Outlook (Microsoft 365)", google: "Gmail (Google Workspace)" } as const;

export function useMailboxes() {
  return useQuery({ queryKey: ["mailboxes"], queryFn: () => api.get<{ available: Record<"microsoft" | "google", boolean>; mailboxes: MailboxInfo[] }>("/mailboxes"), staleTime: 60_000 });
}

/** Unread inbox count for the menu badge (live updates refresh it; otherwise it polls). */
export function useUnreadEmail() {
  const live = useRealtimeConnected();
  return useQuery({ queryKey: ["mailbox", "unread"], queryFn: () => api.get<{ count: number }>("/mailbox/unread-count").then((r) => r.count), refetchInterval: live ? false : 120_000, staleTime: 30_000 });
}
