"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { useState } from "react";
import { SERVICE_TYPE_LABELS, type ServiceType } from "@uo/shared";
import { Dialog } from "@/components/ui/overlays";
import { Button, Field, IssueList, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";

interface Batch {
  campaign: string;
  total: number;
  services: Partial<Record<ServiceType, number>>;
}

const plural = (n: number) => `${n} lead${n === 1 ? "" : "s"}`;

/**
 * Managers: mark a CSV import batch (its campaign), or one service from it, lost with one reason.
 * Only leads still open at New Lead are included; anything already being worked is left alone.
 */
export function CloseLeadBatchButton() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [campaign, setCampaign] = useState("");
  const [service, setService] = useState<ServiceType | "">("");
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [closed, setClosed] = useState<number | null>(null);
  const batches = useQuery({ queryKey: ["lead-batches"], queryFn: () => api.get<Batch[]>("/lead-batches"), enabled: open });
  const batch = batches.data?.find((b) => b.campaign === campaign);
  const count = batch ? (service ? (batch.services[service] ?? 0) : batch.total) : 0;
  const close = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<{ closed: number }>("/lead-batches/close", { campaign, serviceType: service || undefined, reason, expected: count }),
    onSuccess: (r) => {
      setClosed(r.closed);
      setIssues([]);
      // The batch's counts change, so start the next choice afresh.
      setCampaign("");
      setService("");
      setReason("");
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["lead-batches"] });
    },
    onError: (e) => setIssues((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  const start = () => (setOpen(true), setCampaign(""), setService(""), setReason(""), setIssues([]), setClosed(null));

  return (
    <>
      <Button variant="secondary" onClick={start}>
        <Archive /> Close a lead batch
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Close a lead batch"
        description="Marks imported leads that are still at New Lead as Lost, with one reason. They stay in the CRM under Lost and can be reopened one by one."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {closed === null ? "Cancel" : "Close"}
            </Button>
            <Button variant="danger" disabled={!count || !reason.trim()} loading={close.isPending} onClick={() => close.mutate()}>
              Mark {plural(count)} lost
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          {batches.isLoading ? (
            <Skeleton className="h-24" />
          ) : !batches.data?.length ? (
            <p className="text-muted">No imported leads are open at New Lead. Batches are grouped by the Campaign column of the CSV.</p>
          ) : (
            <>
              <Field label="Import batch (campaign)" required>
                {(p) => (
                  <Select {...p} value={campaign} onChange={(e) => (setCampaign(e.target.value), setService(""), setClosed(null))}>
                    <option value="">Choose…</option>
                    {batches.data.map((b) => (
                      <option key={b.campaign} value={b.campaign}>
                        {`${b.campaign} (${plural(b.total)})`}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {batch && (
                <Field label="Which leads">
                  {(p) => (
                    <Select {...p} value={service} onChange={(e) => (setService(e.target.value as ServiceType | ""), setClosed(null))}>
                      <option value="">{`All services (${plural(batch.total)})`}</option>
                      {(Object.keys(batch.services) as ServiceType[]).map((s) => (
                        <option key={s} value={s}>
                          {`Only ${SERVICE_TYPE_LABELS[s]} (${plural(batch.services[s] ?? 0)})`}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}
              <Field label="Reason" required>
                {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Duplicate: one lead per business is kept" />}
              </Field>
            </>
          )}
          {closed !== null && (
            <div role="status" className="rounded-lg bg-success-soft p-3 text-success">
              Marked {plural(closed)} lost.
            </div>
          )}
          <IssueList issues={issues} title="Nothing was changed:" />
        </div>
      </Dialog>
    </>
  );
}
