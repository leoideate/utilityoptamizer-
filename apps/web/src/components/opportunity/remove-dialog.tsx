"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Dialog } from "@/components/ui/overlays";
import { Button, Field, IssueList, Textarea } from "@/components/ui/primitives";
import { ApiError } from "@/lib/api";

/** Asks why something is being removed, then calls `remove` with the reason. The reason is kept with the record. */
export function RemoveDialog({
  title,
  description,
  confirmLabel = "Remove",
  remove,
  onDone,
  onClose,
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  remove: (reason: string) => Promise<unknown>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: () => remove(reason.trim()),
    onSuccess: () => (onDone(), onClose()),
    onError: (e) => setIssues(e instanceof ApiError ? (e.issues.length ? e.issues : [e.message]) : ["Something went wrong."]),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <IssueList issues={issues} title="Can't remove it:" />
        <Field label="Why?" required hint="e.g. Wrong customer's bill, duplicate site. Kept with the history.">
          {(p) => <Textarea {...p} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}
