"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserPlus, X } from "lucide-react";
import { useState } from "react";
import { useAssignableUsers } from "@/components/domain";
import { Button, IssueList, Select } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";

const UNASSIGN = "none";

/**
 * Managers: assigns the opportunities ticked on the list to one salesperson (or unassigns them).
 * Each goes through the same rules as Assign on the deal; any that can't be are listed.
 */
export function BulkAssignBar({ ids, label, onDone, onClear }: { ids: string[]; label: (id: string) => string; onDone: () => void; onClear: () => void }) {
  const qc = useQueryClient();
  const users = useAssignableUsers();
  const [owner, setOwner] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const assign = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<{ assigned: number; skipped: { id: string; reason: string }[] }>("/opportunities/bulk-assign", { ids, ownerId: owner === UNASSIGN ? null : owner }),
    onSuccess: (r) => {
      const name = owner === UNASSIGN ? "nobody" : (users.data?.find((u) => u.id === owner)?.name ?? "the salesperson");
      setResult(`Assigned ${r.assigned} to ${name}.`);
      setIssues(r.skipped.map((s) => `${label(s.id)}: ${s.reason}`));
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      onDone();
    },
    onError: (e) => (setResult(null), setIssues((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message])),
  });

  if (!ids.length && !result && !issues.length) return null;
  return (
    <div role="region" aria-label="Assign selected leads" className="space-y-2 rounded-lg border border-border bg-primary-soft/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{ids.length} selected</span>
        <Select className="min-w-0 sm:w-56" value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Assign to">
          <option value="">Assign to…</option>
          {users.data?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
          <option value={UNASSIGN}>Nobody (unassign)</option>
        </Select>
        <Button disabled={!ids.length || !owner} loading={assign.isPending} onClick={() => (setResult(null), setIssues([]), assign.mutate())}>
          <UserPlus /> Assign
        </Button>
        <Button variant="ghost" onClick={() => (setResult(null), setIssues([]), onClear())}>
          <X /> Clear
        </Button>
      </div>
      {result && (
        <p role="status" className="text-sm text-success">
          {result}
        </p>
      )}
      <IssueList issues={issues} title="Not assigned:" />
    </div>
  );
}
