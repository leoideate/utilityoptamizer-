"use client";

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, MoreHorizontal, Paperclip, Send, X } from "lucide-react";
import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlays";
import { Button, IssueList, Skeleton } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { cn, dateTime } from "@/lib/format";
import { setActiveChannel, useRealtimeConnected } from "@/lib/realtime";
import { useUser } from "@/lib/session";

interface Message {
  id: string;
  authorId: string | null;
  authorName: string;
  body: string | null;
  mentions: string[];
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  attachments: { id: string; filename: string; mimeType: string; size: number; scanStatus: string }[];
}
interface Page {
  channel: { id: string; kind: string; name: string | null; archived: boolean };
  hasMore: boolean;
  messages: Message[];
}
interface Person {
  id: string;
  name: string;
}

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic,.docx,.xlsx";

/** Renders text with mentions of known people highlighted. */
function MessageText({ text, people, me }: { text: string; people: Person[]; me: string }) {
  const parts = useMemo(() => {
    const names = people.map((p) => p.name).sort((a, b) => b.length - a.length);
    if (!names.length) return [text];
    const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")}))`, "g");
    return text.split(re);
  }, [text, people]);
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {parts.map((p, i) => {
        const person = p.startsWith("@") ? people.find((x) => `@${x.name}` === p) : undefined;
        return person ? (
          <span key={i} className={cn("rounded px-0.5 font-medium", person.id === me ? "bg-accent-soft text-warning" : "bg-primary-soft text-primary")}>
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        );
      })}
    </p>
  );
}

/** A conversation: message history (newest at the bottom), composer with @mentions and files. */
export function Conversation({ channelId, compact }: { channelId: string; compact?: boolean }) {
  const me = useUser();
  const qc = useQueryClient();
  const live = useRealtimeConnected();
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [mentions, setMentions] = useState<Person[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [over, setOver] = useState(false);

  const messages = useInfiniteQuery({
    queryKey: ["chat", "messages", channelId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<Page>(`/chat/channels/${channelId}/messages${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.hasMore ? last.messages[0]?.createdAt : undefined),
    // Without the live connection, check for new messages regularly.
    refetchInterval: live ? false : 10_000,
  });
  const people = useQuery({ queryKey: ["chat", "mentionable", channelId], queryFn: () => api.get<Person[]>(`/chat/channels/${channelId}/mentionable`), staleTime: 60_000 });
  const all = useMemo(() => (messages.data?.pages ?? []).slice().reverse().flatMap((p) => p.messages), [messages.data]);
  const archived = messages.data?.pages[0]?.channel.archived;

  useEffect(() => {
    setActiveChannel(channelId);
    return () => setActiveChannel(null);
  }, [channelId]);
  const lastId = all.at(-1)?.id;
  useEffect(() => {
    if (!lastId) return;
    bottom.current?.scrollIntoView({ block: "end" });
    api.post(`/chat/channels/${channelId}/read`).then(() => qc.invalidateQueries({ queryKey: ["chat", "channels"] })).catch(() => undefined);
  }, [lastId, channelId, qc]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["chat", "messages", channelId] });
  const send = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const used = mentions.filter((p) => text.includes(`@${p.name}`)).map((p) => p.id);
      if (!files.length) return api.post(`/chat/channels/${channelId}/messages`, { body: text.trim(), mentions: used });
      const fd = new FormData();
      fd.append("body", text.trim());
      fd.append("mentions", JSON.stringify(used));
      files.forEach((f) => fd.append("files", f));
      return api.postForm(`/chat/channels/${channelId}/messages`, fd);
    },
    onSuccess: () => {
      setText("");
      setFiles([]);
      setMentions([]);
      setIssues([]);
      refresh();
    },
    onError: (e) => setIssues((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  const edit = useMutation({ mutationFn: () => api.patch(`/chat/messages/${editing!.id}`, { body: editing!.text }), onSuccess: () => (setEditing(null), refresh()) });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/chat/messages/${id}`), onSuccess: refresh });

  const candidates = mentionQuery === null ? [] : (people.data ?? []).filter((p) => p.id !== me.id && p.name.toLowerCase().includes(mentionQuery.toLowerCase())).slice(0, 6);
  const onType = (v: string) => {
    setText(v);
    const m = v.match(/@([\p{L} '-]{0,30})$/u);
    setMentionQuery(m ? m[1] : null);
  };
  const pick = (p: Person) => {
    setText((t) => t.replace(/@([\p{L} '-]{0,30})$/u, `@${p.name} `));
    setMentions((m) => (m.some((x) => x.id === p.id) ? m : [...m, p]));
    setMentionQuery(null);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (candidates.length && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      pick(candidates[0]);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (text.trim() || files.length) send.mutate();
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    setFiles((f) => [...f, ...Array.from(e.dataTransfer.files)].slice(0, 5));
  };
  const openFile = async (id: string) => {
    try {
      const r = await api.get<{ url: string }>(`/chat/attachments/${id}/url`);
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      setIssues([(e as ApiError).message]);
    }
  };

  return (
    <div className={cn("flex min-h-0 flex-col", compact ? "h-[560px]" : "h-full")} onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" role="log" aria-label="Messages" aria-live="polite" tabIndex={0}>
        {messages.isLoading && <Skeleton className="h-40" />}
        {messages.hasNextPage && (
          <div className="mb-3 text-center">
            <Button size="sm" variant="ghost" loading={messages.isFetchingNextPage} onClick={() => messages.fetchNextPage()}>
              Load earlier messages
            </Button>
          </div>
        )}
        {!messages.isLoading && !all.length && <p className="py-10 text-center text-sm text-muted">No messages yet. Say hello.</p>}
        <ul className="space-y-3">
          {all.map((m, i) => {
            const mine = m.authorId === me.id;
            const grouped = i > 0 && all[i - 1].authorId === m.authorId && new Date(m.createdAt).getTime() - new Date(all[i - 1].createdAt).getTime() < 5 * 60_000;
            return (
              <li key={m.id} className={cn("group flex gap-3", grouped && "-mt-2")}>
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted", grouped && "invisible")} aria-hidden>
                  {m.authorName
                    .split(" ")
                    .map((x) => x[0])
                    .slice(0, 2)
                    .join("")}
                </span>
                <div className="min-w-0 flex-1">
                  {!grouped && (
                    <p className="text-xs">
                      <span className="font-semibold">{m.authorName}</span> <span className="text-muted">{dateTime(m.createdAt)}</span>
                    </p>
                  )}
                  {m.deleted ? (
                    <p className="text-sm italic text-muted">Message deleted</p>
                  ) : editing?.id === m.id ? (
                    <div className="space-y-2">
                      <textarea className="w-full rounded-lg border border-border bg-surface p-2 text-sm" value={editing.text} onChange={(e) => setEditing({ id: m.id, text: e.target.value })} aria-label="Edit message" autoFocus />
                      <div className="flex gap-2">
                        <Button size="sm" loading={edit.isPending} onClick={() => edit.mutate()}>
                          Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {m.body && <MessageText text={m.body} people={people.data ?? []} me={me.id} />}
                      {m.editedAt && <span className="text-xs text-muted">(edited)</span>}
                      {m.attachments.map((a) => (
                        <button key={a.id} onClick={() => openFile(a.id)} className="mt-1 flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2">
                          <FileText className="size-4 text-muted" aria-hidden />
                          <span className="truncate">{a.filename}</span>
                          <span className="text-xs text-muted">{Math.ceil(a.size / 1024)} KB</span>
                          {a.scanStatus === "infected" && <span className="text-xs text-danger">Removed: failed virus scan</span>}
                        </button>
                      ))}
                    </>
                  )}
                </div>
                {mine && !m.deleted && !editing && (
                  <Menu>
                    <MenuTrigger asChild>
                      <button className="h-6 rounded p-0.5 text-muted opacity-0 hover:bg-surface-2 focus:opacity-100 group-hover:opacity-100" aria-label="Message options">
                        <MoreHorizontal className="size-4" />
                      </button>
                    </MenuTrigger>
                    <MenuContent>
                      {m.body && <MenuItem onSelect={() => setEditing({ id: m.id, text: m.body! })}>Edit</MenuItem>}
                      <MenuItem danger onSelect={() => remove.mutate(m.id)}>
                        Delete
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                )}
              </li>
            );
          })}
        </ul>
        <div ref={bottom} />
      </div>

      {archived ? (
        <p className="border-t border-border px-4 py-3 text-sm text-muted">This channel is archived.</p>
      ) : (
        <div className={cn("relative border-t border-border p-3", over && "bg-primary-soft")}>
          {candidates.length > 0 && (
            <ul className="absolute bottom-full left-3 z-10 mb-1 w-64 rounded-lg border border-border bg-surface p-1 shadow-lg" role="listbox" aria-label="Mention someone">
              {candidates.map((p, i) => (
                <li key={p.id}>
                  <button role="option" aria-selected={i === 0} className={cn("w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-2", i === 0 && "bg-surface-2")} onMouseDown={(e) => (e.preventDefault(), pick(p))}>
                    {p.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {files.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-1 rounded-full bg-surface-2 px-3 py-1 text-xs">
                  {f.name}
                  <button aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <input ref={fileInput} type="file" multiple accept={ACCEPT} className="sr-only" tabIndex={-1} aria-label="Attach files" onChange={(e) => setFiles((f) => [...f, ...Array.from(e.target.files ?? [])].slice(0, 5))} />
            <Button variant="ghost" size="icon" onClick={() => fileInput.current?.click()} aria-label="Attach files">
              <Paperclip />
            </Button>
            <textarea
              value={text}
              onChange={(e) => onType(e.target.value)}
              onKeyDown={onKey}
              rows={Math.min(5, Math.max(1, text.split("\n").length))}
              placeholder="Message… (@ to mention, Shift+Enter for a new line)"
              aria-label="Message"
              className="min-h-10 flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            />
            <Button size="icon" onClick={() => send.mutate()} loading={send.isPending} disabled={!text.trim() && !files.length} aria-label="Send">
              <Send />
            </Button>
          </div>
          {issues.length > 0 && (
            <div className="mt-2">
              <IssueList issues={issues} title="Couldn't send:" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
