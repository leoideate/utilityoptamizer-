"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, X } from "lucide-react";
import Link from "next/link";
import { ACTIVITY_TYPE_LABELS, type ActivityType } from "@uo/shared";
import { Badge, Button } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { cn, date, ref, todayIso } from "@/lib/format";

export interface ActivityRow {
  id: string;
  type: ActivityType;
  summary: string;
  note: string | null;
  dueDate: string;
  priority: "low" | "normal" | "high" | "urgent";
  status: "open" | "done" | "cancelled";
  automationKey: string | null;
  owner: { id: string; name: string } | null;
  opportunity: { id: string; number: number; name: string } | null;
}

export function ActivityList({ items, showOpportunity, onChange }: { items: ActivityRow[]; showOpportunity?: boolean; onChange?: () => void }) {
  const qc = useQueryClient();
  const done = () => {
    qc.invalidateQueries({ queryKey: ["activities"] });
    onChange?.();
  };
  const complete = useMutation({ mutationFn: (id: string) => api.post(`/activities/${id}/complete`, {}), onSuccess: done });
  const cancel = useMutation({ mutationFn: (id: string) => api.post(`/activities/${id}/cancel`), onSuccess: done });
  const today = todayIso();

  return (
    <ul className="divide-y divide-border">
      {items.map((a) => {
        const due = a.dueDate.slice(0, 10);
        const overdue = a.status === "open" && due < today;
        return (
          <li key={a.id} className="flex flex-wrap items-start gap-3 px-5 py-3">
            {a.status === "open" ? (
              <button
                onClick={() => complete.mutate(a.id)}
                className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-border hover:border-primary hover:bg-primary-soft"
                aria-label={`Mark "${a.summary}" done`}
              >
                <Check className="size-3 opacity-0 hover:opacity-100" aria-hidden />
              </button>
            ) : (
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
                <Check className="size-3" aria-hidden />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-medium", a.status !== "open" && "text-muted line-through")}>{a.summary}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span>{ACTIVITY_TYPE_LABELS[a.type]}</span>
                <span className={cn(overdue && "font-medium text-danger")}>{overdue ? `Overdue (${date(due)})` : due === today ? "Due today" : `Due ${date(due)}`}</span>
                {(a.priority === "high" || a.priority === "urgent") && <Badge tone={a.priority === "urgent" ? "danger" : "warning"}>{a.priority}</Badge>}
                {a.automationKey && <Badge>Automatic</Badge>}
                {a.owner && <span>· {a.owner.name}</span>}
                {showOpportunity && a.opportunity && (
                  <Link href={`/opportunities/${a.opportunity.id}`} className="text-primary hover:underline">
                    {ref(a.opportunity.number)} {a.opportunity.name}
                  </Link>
                )}
              </p>
              {a.note && <p className="mt-1 whitespace-pre-line text-xs">{a.note}</p>}
            </div>
            {a.status === "open" && (
              <Button size="icon" variant="ghost" onClick={() => cancel.mutate(a.id)} aria-label={`Cancel "${a.summary}"`}>
                <X />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
