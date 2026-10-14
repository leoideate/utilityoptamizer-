"use client";

import { useQuery } from "@tanstack/react-query";
import { Conversation } from "@/components/chat/conversation";
import { Card, CardHeader, Skeleton } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import type { Workspace } from "@/lib/types";

/** Internal discussion about this deal. Visible to everyone who can see the opportunity; never shown to the customer. */
export function TeamChatTab({ opp }: { opp: Workspace }) {
  const ch = useQuery({ queryKey: ["chat", "deal", opp.id], queryFn: () => api.get<{ id: string }>(`/chat/opportunities/${opp.id}`) });
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Team chat" description="Internal discussion about this deal. Use @ to bring a colleague in. Customers never see this." />
      {ch.data ? <Conversation channelId={ch.data.id} compact /> : <Skeleton className="m-5 h-64" />}
    </Card>
  );
}
