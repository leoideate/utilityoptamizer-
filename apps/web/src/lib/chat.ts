"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { useRealtimeConnected } from "./realtime";

export interface ChannelSummary {
  id: string;
  kind: "direct" | "channel" | "deal";
  name: string | null;
  title: string;
  description: string | null;
  isPrivate?: boolean;
  opportunityId?: string | null;
  unread?: number;
  muted?: boolean;
}
export interface ChannelList {
  channels: ChannelSummary[];
  joinable: ChannelSummary[];
  totalUnread: number;
}

export const useChannels = () => {
  const live = useRealtimeConnected();
  return useQuery({ queryKey: ["chat", "channels"], queryFn: () => api.get<ChannelList>("/chat/channels"), refetchInterval: live ? false : 30_000 });
};

