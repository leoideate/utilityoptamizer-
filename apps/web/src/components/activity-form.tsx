"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { ACTIVITY_TYPES, ACTIVITY_TYPE_LABELS, type ActivityType, PRIORITIES, type Priority } from "@uo/shared";
import { Dialog } from "@/components/ui/overlays";
import { Button, Field, Input, IssueList, Select, Textarea } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { todayIso } from "@/lib/format";
import { useCan, useUser } from "@/lib/session";
import { UserSelect } from "./domain";

export function ActivityDialog({ opportunityId, customerId, onClose }: { opportunityId?: string; customerId?: string | null; onClose: (saved: boolean) => void }) {
  const me = useUser();
  const can = useCan();
  const [v, setV] = useState({ type: "call" as ActivityType, summary: "", note: "", dueDate: todayIso(), priority: "normal" as Priority, reminderAt: "", ownerId: me.id });
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api.post("/activities", {
        ...v,
        note: v.note || null,
        reminderAt: v.reminderAt ? new Date(v.reminderAt).toISOString() : null,
        ownerId: v.ownerId || me.id,
        opportunityId: opportunityId ?? null,
        customerId: customerId ?? null,
      }),
    onSuccess: () => onClose(true),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  const set = <K extends keyof typeof v>(k: K) => (val: (typeof v)[K]) => setV((x) => ({ ...x, [k]: val }));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose(false)}
      title="Schedule a task"
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose(false)}>
            Cancel
          </Button>
          <Button loading={m.isPending} onClick={() => m.mutate()}>
            Save task
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Type">
          {(p) => (
            <Select {...p} value={v.type} onChange={(e) => set("type")(e.target.value as ActivityType)}>
              {ACTIVITY_TYPES.filter((t) => t !== "compliance_review" || can("risk.review")).map((t) => (
                <option key={t} value={t}>
                  {ACTIVITY_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Priority">
          {(p) => (
            <Select {...p} value={v.priority} onChange={(e) => set("priority")(e.target.value as Priority)}>
              {PRIORITIES.map((x) => (
                <option key={x} value={x}>
                  {x[0].toUpperCase() + x.slice(1)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="What needs doing?" required className="sm:col-span-2">
          {(p) => <Input {...p} value={v.summary} onChange={(e) => set("summary")(e.target.value)} placeholder="e.g. Call to confirm meter read" autoFocus />}
        </Field>
        <Field label="Due date">{(p) => <Input {...p} type="date" value={v.dueDate} onChange={(e) => set("dueDate")(e.target.value)} />}</Field>
        <Field label="Remind me at" hint="Optional: a notification at this time.">
          {(p) => <Input {...p} type="datetime-local" value={v.reminderAt} onChange={(e) => set("reminderAt")(e.target.value)} />}
        </Field>
        {can("opportunity.write_all") && (
          <Field label="Owner" className="sm:col-span-2">
            {(p) => <UserSelect {...p} value={v.ownerId} onChange={set("ownerId")} />}
          </Field>
        )}
        <Field label="Notes" className="sm:col-span-2">
          {(p) => <Textarea {...p} value={v.note} onChange={(e) => set("note")(e.target.value)} />}
        </Field>
      </div>
      <div className="mt-4">
        <IssueList issues={issues} title="Please check:" />
      </div>
    </Dialog>
  );
}
