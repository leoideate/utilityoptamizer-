"use client";

import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, createContext, useContext, useEffect, useState } from "react";
import { toast } from "sonner";

interface ChatEvent {
  channelId: string;
  messageId?: string;
  authorId?: string;
  authorName?: string;
  preview?: string;
  mentions?: string[];
}

const ConnectedContext = createContext(false);
/** True while the live connection is open (otherwise screens fall back to polling). */
export const useRealtimeConnected = () => useContext(ConnectedContext);

/** Which conversation is on screen, so its new messages don't also pop up as toasts. */
let activeChannel: string | null = null;
export const setActiveChannel = (id: string | null) => {
  activeChannel = id;
};

/**
 * One Server-Sent Events connection per tab. Events only say *what* changed; the affected
 * queries are re-fetched through the normal, permission-checked API.
 */
export function RealtimeProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/realtime/stream");
    es.addEventListener("ready", () => setConnected(true));
    es.onerror = () => setConnected(false);
    const chat = (e: MessageEvent) => {
      const d = JSON.parse(e.data) as ChatEvent;
      qc.invalidateQueries({ queryKey: ["chat", "channels"] });
      qc.invalidateQueries({ queryKey: ["chat", "messages", d.channelId] });
      if (e.type === "chat.message" && d.authorId !== userId && d.channelId !== activeChannel) {
        const mentioned = d.mentions?.includes(userId);
        toast(mentioned ? `${d.authorName} mentioned you` : `New message from ${d.authorName}`, {
          description: d.preview,
          action: { label: "Open", onClick: () => window.location.assign(`/chat?c=${d.channelId}`) },
        });
      }
    };
    es.addEventListener("chat.message", chat);
    es.addEventListener("chat.message.updated", chat);
    es.addEventListener("chat.read", () => qc.invalidateQueries({ queryKey: ["chat", "channels"] }));
    es.addEventListener("call.updated", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { callId: string; opportunityId: string | null };
      qc.invalidateQueries({ queryKey: ["call", d.callId] });
      if (d.opportunityId) {
        qc.invalidateQueries({ queryKey: ["calls", d.opportunityId] });
        qc.invalidateQueries({ queryKey: ["opportunity", d.opportunityId] });
      }
    });
    es.addEventListener("notification", () => qc.invalidateQueries({ queryKey: ["notifications"] }));
    return () => es.close();
  }, [qc, userId]);

  return <ConnectedContext.Provider value={connected}>{children}</ConnectedContext.Provider>;
}
