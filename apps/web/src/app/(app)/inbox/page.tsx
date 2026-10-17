"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Briefcase, Building2, Inbox, Mail, Paperclip, RefreshCw, Reply, Send } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import { Badge, Button, Card, EmptyState, Field, IssueList, Skeleton, Textarea } from "@/components/ui/primitives";
import { type ApiError, api, idempotencyKey, qs } from "@/lib/api";
import { type EmailDetail, type EmailSummary, type MailboxInfo, useMailboxes } from "@/lib/email";
import { cn, dateTime, relative } from "@/lib/format";
import { useRealtimeConnected } from "@/lib/realtime";

type Folder = "inbox" | "sent";
const PAGE_SIZE = 50;

function InboxPage() {
  const params = useSearchParams();
  const router = useRouter();
  const folder: Folder = params.get("folder") === "sent" ? "sent" : "inbox";
  const active = params.get("id");
  const [pages, setPages] = useState(1);
  const live = useRealtimeConnected();
  const boxes = useMailboxes();
  const list = useQuery({
    queryKey: ["inbox", folder, pages],
    queryFn: () => api.get<{ items: EmailSummary[]; total: number }>(`/mailbox/messages${qs({ folder, page: 1, pageSize: PAGE_SIZE * pages })}`),
    refetchInterval: live ? false : 60_000,
  });
  const go = (next: { folder?: Folder; id?: string | null }) => {
    const f = next.folder ?? folder;
    const id = next.id === undefined ? active : next.id;
    router.replace(`/inbox${qs({ folder: f === "sent" ? "sent" : undefined, id: id ?? undefined })}`);
  };
  const connected = boxes.data?.mailboxes ?? [];

  return (
    <div className="-my-2">
      <h1 className="sr-only">Email</h1>
      <Card className="grid h-[calc(100dvh-8rem)] min-h-[480px] overflow-hidden md:grid-cols-[minmax(280px,380px)_1fr]">
        <nav aria-label="Messages" className={cn("flex min-h-0 min-w-0 flex-col border-r border-border", active && "hidden md:flex")}>
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <div role="group" aria-label="Folder" className="grid flex-1 grid-cols-2 overflow-hidden rounded-full border border-[var(--md-sys-color-outline)]">
              {(["inbox", "sent"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={folder === f}
                  onClick={() => (setPages(1), go({ folder: f, id: null }))}
                  className={cn("min-h-10 px-2 text-sm font-medium first:border-r first:border-[var(--md-sys-color-outline)]", folder === f && "bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]")}
                >
                  {f === "inbox" ? "Inbox" : "Sent"}
                </button>
              ))}
            </div>
            <SyncButton boxes={connected} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" tabIndex={0}>
            {boxes.isSuccess && !connected.length ? (
              <EmptyState icon={<Mail />} title="Connect your mailbox" action={<Button asChild><Link href="/account#mailbox">Connect Outlook or Gmail</Link></Button>}>
                Your inbox and sent mail appear here, and emails with customers are added to their deals automatically.
              </EmptyState>
            ) : list.isLoading ? (
              <Skeleton className="m-3 h-40" />
            ) : !list.data?.items.length ? (
              <EmptyState icon={<Inbox />} title={folder === "inbox" ? "No emails yet" : "Nothing sent yet"}>
                {connected.some((b) => !b.lastSyncedAt) ? "Your mailbox is still syncing. This takes a minute or two." : "New mail shows up here within a couple of minutes."}
              </EmptyState>
            ) : (
              <ul>
                {list.data.items.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => go({ id: m.id })}
                      aria-current={m.id === active ? "page" : undefined}
                      className={cn("block w-full border-b border-border px-4 py-3 text-left hover:bg-surface-2", m.id === active && "bg-primary-soft")}
                    >
                      <span className="flex items-baseline gap-2">
                        <span className={cn("min-w-0 flex-1 truncate text-sm", m.unread && "font-semibold")}>
                          {folder === "inbox" ? (m.fromName ?? m.fromAddress) : `To ${m.toAddresses.join(", ")}`}
                        </span>
                        <span className="shrink-0 text-xs text-muted">{relative(m.sentAt)}</span>
                      </span>
                      <span className={cn("mt-0.5 flex items-center gap-1 truncate text-sm", m.unread ? "font-semibold" : "text-text")}>
                        {m.unread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                        <span className="truncate">{m.subject || "(no subject)"}</span>
                        {m.hasAttachments && <Paperclip className="size-3 shrink-0 text-muted" aria-label="Has attachments" />}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted">{m.snippet}</span>
                      <LinkChips m={m} />
                    </button>
                  </li>
                ))}
                {list.data.total > list.data.items.length && (
                  <li className="p-3">
                    <Button variant="secondary" className="w-full" onClick={() => setPages((p) => p + 1)} loading={list.isFetching}>
                      Show more
                    </Button>
                  </li>
                )}
              </ul>
            )}
          </div>
        </nav>

        <section className={cn("flex min-h-0 min-w-0 flex-col", !active && "hidden md:flex")} aria-label="Email">
          {active ? (
            <Message key={active} id={active} onBack={() => go({ id: null })} />
          ) : (
            <div className="m-auto p-6">
              <EmptyState icon={<Mail />} title="Choose an email">
                Emails linked to a customer or deal are on its timeline too, for everyone working that deal.
              </EmptyState>
            </div>
          )}
        </section>
      </Card>
    </div>
  );
}

function LinkChips({ m }: { m: Pick<EmailSummary, "opportunityName" | "customerName" | "opportunityId"> }) {
  if (!m.opportunityName && !m.customerName) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {m.opportunityName ? (
        <Badge tone="primary">
          <Briefcase className="size-3" aria-hidden /> {m.opportunityName}
        </Badge>
      ) : (
        <Badge>
          <Building2 className="size-3" aria-hidden /> {m.customerName}
        </Badge>
      )}
    </span>
  );
}

function SyncButton({ boxes }: { boxes: MailboxInfo[] }) {
  const qc = useQueryClient();
  const sync = useMutation({
    mutationFn: () => Promise.all(boxes.filter((b) => b.status === "active").map((b) => api.post(`/mailboxes/${b.id}/sync`))),
    onSuccess: () => {
      toast("Checking for new mail…");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["inbox"] }), 5_000);
    },
  });
  if (!boxes.some((b) => b.status === "active")) return null;
  return (
    <Button size="icon" variant="ghost" onClick={() => sync.mutate()} loading={sync.isPending} aria-label="Check for new mail">
      <RefreshCw />
    </Button>
  );
}

function Message({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient();
  const { data: m, isLoading, error } = useQuery({
    queryKey: ["email", id],
    queryFn: async () => {
      const e = await api.get<EmailDetail>(`/emails/${id}`);
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["mailbox", "unread"] });
      return e;
    },
    retry: false,
  });
  const [replying, setReplying] = useState(false);

  return (
    <>
      <header className="flex items-start gap-2 border-b border-border px-4 py-3">
        <Button size="icon" variant="ghost" className="md:hidden" onClick={onBack} aria-label="Back to messages">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          {m ? (
            <>
              <h2 className="break-words font-semibold">{m.subject || "(no subject)"}</h2>
              <p className="mt-1 text-xs text-muted">
                <span className="font-medium text-text">{m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}</span> · {dateTime(m.sentAt)}
              </p>
              <p className="break-words text-xs text-muted">To {m.toAddresses.join(", ")}{m.ccAddresses.length ? ` · Cc ${m.ccAddresses.join(", ")}` : ""}</p>
            </>
          ) : (
            <Skeleton className="h-10" />
          )}
        </div>
        {m?.canReply && (
          <Button size="sm" variant="secondary" onClick={() => setReplying(true)}>
            <Reply /> Reply
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" tabIndex={0}>
        {error ? (
          <EmptyState icon={<Mail />} title="This email isn't available">
            It may belong to someone else's mailbox and not be linked to a deal you can see.
          </EmptyState>
        ) : isLoading || !m ? (
          <Skeleton className="h-48" />
        ) : (
          <>
            {(m.opportunityId || m.customerId) && (
              <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 p-3 text-sm">
                <span className="text-muted">Linked to</span>
                {m.opportunityId && (
                  <Link className="font-medium text-primary underline" href={`/opportunities/${m.opportunityId}`}>
                    {m.opportunityName ?? "deal"}
                  </Link>
                )}
                {m.customerId && (
                  <Link className="font-medium text-primary underline" href={`/customers/${m.customerId}`}>
                    {m.customerName ?? "customer"}
                  </Link>
                )}
              </div>
            )}
            {!m.isOwner && <p className="mb-3 text-xs text-muted">From {m.mailbox.ownerName}'s mailbox ({m.mailbox.address}).</p>}
            {m.isOwner && !m.canReply && (
              <p className="mb-3 text-xs text-muted">
                Your mailbox needs reconnecting before you can reply.{" "}
                <Link className="text-primary underline" href="/account#mailbox">
                  Reconnect it
                </Link>
              </p>
            )}
            {m.hasAttachments && (
              <p className="mb-3 flex items-center gap-1 text-xs text-muted">
                <Paperclip className="size-3" aria-hidden /> Has attachments. Open it in {m.mailbox.provider === "google" ? "Gmail" : "Outlook"} to see them.
              </p>
            )}
            <div className="whitespace-pre-wrap break-words text-sm leading-6">{m.body || m.snippet}</div>
            {replying && <ReplyBox email={m} onDone={() => setReplying(false)} />}
          </>
        )}
      </div>
    </>
  );
}

function ReplyBox({ email, onDone }: { email: EmailDetail; onDone: () => void }) {
  const qc = useQueryClient();
  const [key] = useState(idempotencyKey);
  const [body, setBody] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const send = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post(`/emails/${email.id}/reply`, { body, idempotencyKey: key }),
    onSuccess: () => {
      toast("Reply sent");
      if (email.opportunityId) qc.invalidateQueries({ queryKey: ["opportunity", email.opportunityId, "timeline"] });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["inbox", "sent"] }), 5_000);
      onDone();
    },
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <div className="mt-6 space-y-3 border-t border-border pt-4">
      <Field label={`Reply to ${email.direction === "inbound" ? email.fromAddress : email.toAddresses.join(", ")}`}>{(p) => <Textarea {...p} rows={6} autoFocus value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
      <p className="text-xs text-muted">Sent from {email.mailbox.address}, in the same thread.</p>
      <IssueList issues={issues} title="Please check:" />
      <div className="flex gap-2">
        <Button onClick={() => (setIssues([]), send.mutate())} loading={send.isPending} disabled={!body.trim()}>
          <Send /> Send reply
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <InboxPage />
    </Suspense>
  );
}
