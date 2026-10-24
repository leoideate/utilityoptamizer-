"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BellOff, Hash, Lock, MessageSquarePlus, Plus, Briefcase, User } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Conversation } from "@/components/chat/conversation";
import { useAssignableUsers } from "@/components/domain";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Card, Checkbox, EmptyState, Field, Input, IssueList, Select } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { type ChannelSummary, useChannels } from "@/lib/chat";
import { cn } from "@/lib/format";
import { useCan, useUser } from "@/lib/session";

const ICON = { direct: User, channel: Hash, deal: Briefcase };

function ChatPage() {
  const params = useSearchParams();
  const router = useRouter();
  const can = useCan();
  const qc = useQueryClient();
  const { data } = useChannels();
  const active = params.get("c");
  const [dialog, setDialog] = useState<null | "dm" | "channel">(null);
  const select = (id: string) => router.replace(`/chat?c=${id}`);
  const join = useMutation({ mutationFn: (id: string) => api.post(`/chat/channels/${id}/join`), onSuccess: (_d, id) => (qc.invalidateQueries({ queryKey: ["chat", "channels"] }), select(id)) });
  const mute = useMutation({ mutationFn: ({ id, muted }: { id: string; muted: boolean }) => api.post(`/chat/channels/${id}/mute`, { muted }), onSuccess: () => qc.invalidateQueries({ queryKey: ["chat", "channels"] }) });
  const current = data?.channels.find((c) => c.id === active) ?? data?.joinable.find((c) => c.id === active);

  const groups: [string, ChannelSummary[]][] = [
    ["Channels", data?.channels.filter((c) => c.kind === "channel") ?? []],
    ["Direct messages", data?.channels.filter((c) => c.kind === "direct") ?? []],
    ["Deal discussions", data?.channels.filter((c) => c.kind === "deal") ?? []],
  ];

  return (
    <div className="-my-2">
      <h1 className="sr-only">Chat</h1>
      <Card className="grid h-[calc(100dvh-8rem)] min-h-[480px] overflow-hidden md:grid-cols-[280px_1fr]">
        <nav aria-label="Conversations" className={cn("flex min-h-0 flex-col border-r border-border", active && "hidden md:flex")}>
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <p className="font-semibold">Chat</p>
            <div className="flex gap-1">
              <Button size="icon" variant="ghost" onClick={() => setDialog("dm")} aria-label="New direct message">
                <MessageSquarePlus />
              </Button>
              {can("chat.manage_channels") && (
                <Button size="icon" variant="ghost" onClick={() => setDialog("channel")} aria-label="New channel">
                  <Plus />
                </Button>
              )}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2" tabIndex={0}>
            {groups.map(([label, list]) => (
              <div key={label} className="mb-3">
                <p className="px-2 pb-1 text-xs font-medium text-muted">{label}</p>
                {!list.length && <p className="px-2 text-xs text-muted">None yet</p>}
                {list.map((c) => {
                  const Icon = ICON[c.kind];
                  return (
                    <button
                      key={c.id}
                      onClick={() => select(c.id)}
                      aria-current={c.id === active ? "page" : undefined}
                      className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2", c.id === active && "bg-primary-soft text-primary", c.unread && "font-semibold")}
                    >
                      <Icon className="size-4 shrink-0 text-muted" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{c.kind === "channel" ? c.name : c.title}</span>
                      {c.isPrivate && <Lock className="size-3 text-muted" aria-label="Private" />}
                      {c.muted && <BellOff className="size-3 text-muted" aria-label="Muted" />}
                      {!!c.unread && <Badge tone={c.muted ? "neutral" : "primary"}>{c.unread}</Badge>}
                    </button>
                  );
                })}
              </div>
            ))}
            {!!data?.joinable.length && (
              <div className="mb-3">
                <p className="px-2 pb-1 text-xs font-medium text-muted">Other channels</p>
                {data.joinable.map((c) => (
                  <button key={c.id} onClick={() => select(c.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted hover:bg-surface-2">
                    <Hash className="size-4" aria-hidden /> {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>

        <section className={cn("flex min-h-0 flex-col", !active && "hidden md:flex")} aria-label={current?.title ?? "Conversation"}>
          {active && current ? (
            <>
              <header className="flex items-center gap-3 border-b border-border px-4 py-3">
                <Button size="icon" variant="ghost" className="md:hidden" onClick={() => router.replace("/chat")} aria-label="Back to conversations">
                  <ArrowLeft />
                </Button>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-semibold">{current.kind === "channel" ? `#${current.name}` : current.title}</h2>
                  {current.description && <p className="truncate text-xs text-muted">{current.description}</p>}
                </div>
                {current.kind === "deal" && current.opportunityId && (
                  <Button size="sm" variant="secondary" asChild>
                    <Link href={`/opportunities/${current.opportunityId}`}>Open deal</Link>
                  </Button>
                )}
                {data?.joinable.some((j) => j.id === current.id) ? (
                  <Button size="sm" onClick={() => join.mutate(current.id)} loading={join.isPending}>
                    Join channel
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => mute.mutate({ id: current.id, muted: !current.muted })}>
                    {current.muted ? "Unmute" : "Mute"}
                  </Button>
                )}
              </header>
              <Conversation key={current.id} channelId={current.id} />
            </>
          ) : (
            <EmptyState icon={<MessageSquarePlus />} title="Pick a conversation">
              Message a colleague, talk in a team channel, or discuss a deal from its <strong>Team chat</strong> tab.
            </EmptyState>
          )}
        </section>
      </Card>
      {dialog === "dm" && <DirectDialog onClose={() => setDialog(null)} onOpen={select} />}
      {dialog === "channel" && <ChannelDialog onClose={() => setDialog(null)} onOpen={select} />}
    </div>
  );
}

function DirectDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const me = useUser();
  const users = useAssignableUsers();
  const qc = useQueryClient();
  const [userId, setUserId] = useState("");
  const open = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/chat/direct/${userId}`),
    onSuccess: (c) => (qc.invalidateQueries({ queryKey: ["chat", "channels"] }), onOpen(c.id), onClose()),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New direct message"
      footer={
        <Button disabled={!userId} loading={open.isPending} onClick={() => open.mutate()}>
          Start conversation
        </Button>
      }
    >
      <Field label="Colleague">
        {(p) => (
          <Select {...p} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose…</option>
            {users.data?.filter((u) => u.id !== me.id).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </Dialog>
  );
}

function ChannelDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (id: string) => void }) {
  const users = useAssignableUsers();
  const me = useUser();
  const qc = useQueryClient();
  const [v, setV] = useState({ name: "", description: "", isPrivate: false, memberIds: [] as string[] });
  const [issues, setIssues] = useState<string[]>([]);
  const create = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<{ id: string }>("/chat/channels", { ...v, description: v.description || null }),
    onSuccess: (c) => (qc.invalidateQueries({ queryKey: ["chat", "channels"] }), onOpen(c.id), onClose()),
    onError: (e) => setIssues((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New channel"
      footer={
        <Button loading={create.isPending} onClick={() => create.mutate()}>
          Create channel
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Name" hint="Lowercase, e.g. sales-team or worldpay">
          {(p) => <Input {...p} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value.toLowerCase().replace(/\s+/g, "-") })} />}
        </Field>
        <Field label="Description">{(p) => <Input {...p} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />}</Field>
        <Checkbox label="Private: only people you add can see it" checked={v.isPrivate} onChange={(e) => setV({ ...v, isPrivate: e.target.checked })} />
        {v.isPrivate && (
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Members</legend>
            <div className="grid max-h-48 grid-cols-2 gap-2 overflow-y-auto">
              {users.data?.filter((u) => u.id !== me.id).map((u) => (
                <Checkbox key={u.id} label={u.name} checked={v.memberIds.includes(u.id)} onChange={(e) => setV({ ...v, memberIds: e.target.checked ? [...v.memberIds, u.id] : v.memberIds.filter((x) => x !== u.id) })} />
              ))}
            </div>
          </fieldset>
        )}
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}

export default function Page() {
  const user = useUser();
  if (!user.features.chat)
    return (
      <EmptyState icon={<BellOff />} title="Chat is turned off">
        Ask an administrator if your team needs it.
      </EmptyState>
    );
  return (
    <Suspense>
      <ChatPage />
    </Suspense>
  );
}
