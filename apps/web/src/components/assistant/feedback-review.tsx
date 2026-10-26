"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardHeader, EmptyState, Skeleton } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { Answer } from "./assistant-panel";

interface Unhelpful {
  id: string;
  createdAt: string;
  comment: string | null;
  question: string | null;
  answer: string;
  toolsUsed: string[];
}

/** Answers people marked unhelpful, newest first: the material for improving the assistant's instructions. */
export function AssistantFeedbackReview() {
  const { data, isLoading } = useQuery({ queryKey: ["assistant", "feedback"], queryFn: () => api.get<Unhelpful[]>("/assistant/feedback") });
  return (
    <Card>
      <CardHeader title="Assistant feedback" description="Answers marked “not helpful” in the last 90 days, with the question asked. Send the patterns to whoever maintains the assistant's instructions." />
      {isLoading || !data ? (
        <Skeleton className="m-5 h-32" />
      ) : data.length === 0 ? (
        <EmptyState title="No unhelpful answers">Nobody has marked an answer as not helpful yet.</EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((f) => (
            <li key={f.id} className="space-y-2 px-5 py-4 text-sm">
              <p className="text-xs text-muted">
                {dateTime(f.createdAt)}
                {f.toolsUsed.length > 0 && ` · looked up: ${f.toolsUsed.join(", ")}`}
              </p>
              {f.question && <p className="font-medium">“{f.question}”</p>}
              <div className="rounded-[var(--md-sys-shape-corner-small)] bg-[var(--md-sys-color-surface-container)] p-3">
                <Answer body={f.answer} />
              </div>
              {f.comment && <p className="text-danger">Feedback: {f.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
