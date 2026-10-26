"use client";

import { useMutation } from "@tanstack/react-query";
import { Send, Sparkles, SquarePen, ThumbsDown, ThumbsUp, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button, Textarea } from "@/components/ui/primitives";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/format";

interface Message {
  id: string;
  role: "user" | "assistant";
  body: string;
  toolsUsed: string[];
  feedback?: { helpful: boolean }[];
}

const UUID = /^\/opportunities\/([0-9a-f-]{36})/i;
const ON_DEAL = ["What's blocking this deal?", "Which documents are still missing?", "What should I do next on this deal?"];
const ELSEWHERE = ["Which of my deals are stuck?", "What are my overdue tasks?", "How do I submit a deal to the supplier?"];

/** Bold and links inside one line of an answer. Only links into the CRM ("/…") become links. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={`${key}-${m.index}`}>{m[1]}</strong>);
    else if (m[3].startsWith("/") && !m[3].startsWith("//"))
      out.push(
        <Link key={`${key}-${m.index}`} href={m[3]} className="font-medium text-primary underline underline-offset-2">
          {m[2]}
        </Link>,
      );
    else out.push(m[2]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The small Markdown the assistant writes: paragraphs, "-" or "1." lists, bold and links. */
export function Answer({ body }: { body: string }) {
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={`l${blocks.length}`} className={cn("ml-5 space-y-0.5", list.ordered ? "list-decimal" : "list-disc")}>
        {list.items.map((item, i) => (
          <li key={i}>{inline(item, `l${blocks.length}-${i}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  body.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
      return;
    }
    flush();
    if (line) blocks.push(<p key={`p${i}`}>{inline(line.replace(/^#+\s*/, ""), `p${i}`)}</p>);
  });
  flush();
  return <div className="space-y-2">{blocks}</div>;
}

function Feedback({ message }: { message: Message }) {
  const [sent, setSent] = useState<boolean | null>(message.feedback?.[0]?.helpful ?? null);
  const [asking, setAsking] = useState(false);
  const [comment, setComment] = useState("");
  const send = useMutation({ meta: { silent: true }, mutationFn: (b: { helpful: boolean; comment?: string | null }) => api.post(`/assistant/messages/${message.id}/feedback`, b), onSuccess: (_d, b) => (setSent(b.helpful), setAsking(false)) });
  if (sent !== null) return <p className="mt-1 text-xs text-muted">{sent ? "Thanks for the feedback." : "Thanks: we'll use this to improve the assistant."}</p>;
  return (
    <div className="mt-1">
      <div className="flex items-center gap-1">
        <button type="button" className="inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)]" aria-label="Helpful" onClick={() => send.mutate({ helpful: true })}>
          <ThumbsUp className="size-4" aria-hidden />
        </button>
        <button type="button" className="inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)]" aria-label="Not helpful" onClick={() => setAsking(true)}>
          <ThumbsDown className="size-4" aria-hidden />
        </button>
      </div>
      {asking && (
        <div className="mt-1 space-y-2">
          <Textarea aria-label="What was wrong with this answer?" placeholder="What was wrong? (optional)" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
          <Button size="sm" variant="secondary" loading={send.isPending} onClick={() => send.mutate({ helpful: false, comment: comment.trim() || null })}>
            Send feedback
          </Button>
        </div>
      )}
    </div>
  );
}

/** "Ask the CRM": a side panel (full screen on phones) that answers from the CRM with the user's own access. */
export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const pathname = usePathname();
  const dealId = UUID.exec(pathname)?.[1] ?? null;
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const ask = useMutation({
    meta: { silent: true },
    mutationFn: (message: string) => api.post<{ conversationId: string; message: Message }>("/assistant/messages", { conversationId, opportunityId: dealId, message }),
    onMutate: (message) => {
      setError(null);
      setMessages((m) => [...m, { id: `local-${m.length}`, role: "user", body: message, toolsUsed: [] }]);
      setText("");
    },
    onSuccess: (r) => {
      setConversationId(r.conversationId);
      setMessages((m) => [...m, r.message]);
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : "The assistant couldn't be reached. Try again."),
  });

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, ask.isPending]);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // The Material text field upgrades after mount; focus it on the next frame.
    const frame = requestAnimationFrame(() => input.current?.focus());
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", esc);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", esc);
    };
  }, []);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const q = text.trim();
    if (q && !ask.isPending) ask.mutate(q);
  };

  return (
    <aside role="dialog" aria-label="Ask the CRM" className="fixed inset-0 z-40 flex flex-col bg-[var(--md-sys-color-surface-container-low)] md:inset-y-0 md:left-auto md:right-0 md:w-[26rem] md:border-l md:border-border md:shadow-xl">
      <div className="flex h-16 shrink-0 items-center gap-2 px-4">
        <Sparkles className="size-5 text-primary" aria-hidden />
        <h2 className="flex-1 text-base font-medium">Ask the CRM</h2>
        {messages.length > 0 && (
          <Button variant="ghost" size="icon" aria-label="New conversation" title="New conversation" onClick={() => (setConversationId(null), setMessages([]), setError(null))}>
            <SquarePen />
          </Button>
        )}
        <Button variant="ghost" size="icon" aria-label="Close assistant" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4 text-sm" aria-live="polite">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-muted">Ask about {dealId ? "this deal" : "your deals"}, your tasks or how the CRM works. I can look things up but can't change anything.</p>
            <div className="flex flex-col items-start gap-2">
              {(dealId ? ON_DEAL : ELSEWHERE).map((s) => (
                <button key={s} type="button" className="min-h-8 rounded-full border border-border px-3 py-1 text-left text-sm hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_8%,transparent)]" onClick={() => ask.mutate(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <p key={m.id} className="ml-8 whitespace-pre-wrap rounded-[var(--md-sys-shape-corner-medium)] bg-[var(--md-sys-color-secondary-container)] px-3 py-2 text-[var(--md-sys-color-on-secondary-container)]">
              {m.body}
            </p>
          ) : (
            <div key={m.id} className="mr-4">
              <Answer body={m.body} />
              {!m.id.startsWith("local-") && <Feedback message={m} />}
            </div>
          ),
        )}
        {ask.isPending && (
          <p className="flex items-center gap-2 text-muted">
            <Sparkles className="size-4 animate-pulse text-primary" aria-hidden /> Looking that up…
          </p>
        )}
        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <div ref={end} />
      </div>
      <form onSubmit={submit} className="flex shrink-0 items-end gap-2 border-t border-border p-3">
        <Textarea
          ref={input}
          aria-label="Your question"
          placeholder="Ask a question…"
          rows={2}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit(e);
          }}
          className="flex-1"
        />
        <Button type="button" size="icon" aria-label="Send" disabled={!text.trim()} loading={ask.isPending} onClick={() => submit()}>
          <Send />
        </Button>
      </form>
    </aside>
  );
}
