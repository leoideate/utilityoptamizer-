"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { SERVICE_TYPE_LABELS, type ServiceType } from "@uo/shared";
import { Button, Card, CardHeader, Field, Input, IssueList, Select, Skeleton } from "@/components/ui/primitives";
import { type ApiError, api, qs } from "@/lib/api";

interface Preview {
  deletable: number;
  kept: number;
  campaigns: string[];
}

const plural = (n: number) => `${n} lead${n === 1 ? "" : "s"}`;

/**
 * Administrators: permanently delete leads still at New Lead that nobody has worked on, all of them
 * or one import batch and/or service. Leads with anything attached (forms, documents, calls,
 * emails, sites, quotes…) are kept. One audit entry records the UO numbers deleted.
 */
export function DeleteLeadsCard() {
  const qc = useQueryClient();
  const [campaign, setCampaign] = useState("");
  const [service, setService] = useState<ServiceType | "">("");
  const [confirm, setConfirm] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [deleted, setDeleted] = useState<number | null>(null);
  const filter = { campaign: campaign || undefined, serviceType: service || undefined };
  const preview = useQuery({ queryKey: ["lead-purge", filter], queryFn: () => api.get<Preview>(`/lead-purge${qs(filter)}`), placeholderData: (p) => p });
  const count = preview.data?.deletable ?? 0;
  const purge = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<{ deleted: number }>("/lead-purge", { ...filter, expected: count, confirm }),
    onSuccess: (r) => {
      setDeleted(r.deleted);
      setIssues([]);
      setConfirm("");
      qc.invalidateQueries({ queryKey: ["lead-purge"] });
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["lead-batches"] });
    },
    onError: (e) => setIssues((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });

  return (
    <Card>
      <CardHeader
        title="Delete leads"
        description="Permanently deletes leads still at New Lead (open or lost) that nobody has worked on. This can't be undone: the lead, its tasks and its timeline go; the audit log keeps the UO numbers."
      />
      <div className="space-y-4 p-5 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Import batch (campaign)">
            {(p) => (
              <Select {...p} value={campaign} onChange={(e) => (setCampaign(e.target.value), setDeleted(null))}>
                <option value="">All leads</option>
                {preview.data?.campaigns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Service">
            {(p) => (
              <Select {...p} value={service} onChange={(e) => (setService(e.target.value as ServiceType | ""), setDeleted(null))}>
                <option value="">All services</option>
                {(Object.keys(SERVICE_TYPE_LABELS) as ServiceType[]).map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_TYPE_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {preview.isLoading ? (
          <Skeleton className="h-10" />
        ) : (
          <p aria-live="polite">
            <strong>{plural(count)}</strong> can be deleted.
            {!!preview.data?.kept && ` ${plural(preview.data.kept)} at New Lead ${preview.data.kept === 1 ? "is" : "are"} kept because somebody worked on ${preview.data.kept === 1 ? "it" : "them"} (forms, documents, calls, emails, sites or quotes); mark those lost instead.`}
          </p>
        )}
        <Field label="Type DELETE to confirm">
          {(p) => <Input {...p} className="max-w-48" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />}
        </Field>
        <Button variant="danger" disabled={!count || confirm !== "DELETE"} loading={purge.isPending} onClick={() => purge.mutate()}>
          <Trash2 /> Delete {plural(count)}
        </Button>
        {deleted !== null && (
          <div role="status" className="rounded-lg bg-success-soft p-3 text-success">
            Deleted {plural(deleted)}.
          </div>
        )}
        <IssueList issues={issues} title="Nothing was deleted:" />
      </div>
    </Card>
  );
}
