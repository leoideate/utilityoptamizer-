"use client";

import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BillReading, FillSuggestion } from "@uo/shared";
import { Dialog } from "@/components/ui/overlays";
import { Button, Checkbox, IssueList, Skeleton } from "@/components/ui/primitives";
import { ApiError, api } from "@/lib/api";
import { date } from "@/lib/format";

interface Doc {
  documentType: string;
  versions: { id: string; scanStatus: string; uploadedAt: string }[];
}

/** Dates as people read them; everything else as it is. */
const shown = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? date(v) : v);
const failure = (e: unknown) => (e instanceof ApiError ? (e.issues.length ? e.issues : [e.message]) : ["Something went wrong. Try again."]);

/**
 * "Fill from bill" on a supplier application: the AI reads the deal's latest energy bill, and each
 * form field it can fill is shown beside what the form has. Only ticked values are saved, through
 * the application's own save (so they also go back to the CRM records).
 */
export function FillFromBillDialog<D, V extends { data: D }>({
  opportunityId,
  endpoint,
  data,
  suggest,
  saveFor,
  stillNeeded,
  onSaved,
  onClose,
}: {
  opportunityId: string;
  /** The application's API path, e.g. /opportunities/<id>/flogas-electricity. */
  endpoint: string;
  data: D;
  suggest: (r: BillReading, d: D) => FillSuggestion[];
  saveFor: (r: BillReading, d: D, keys: ReadonlySet<string>) => object;
  /** What the form will still need that a bill can't give (shown below the list). */
  stillNeeded: string[];
  onSaved: (view: V) => void;
  onClose: () => void;
}) {
  const read = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const docs = await api.get<Doc[]>(`/opportunities/${opportunityId}/documents`);
      const bill = docs.find((d) => d.documentType === "energy_bill")?.versions.find((v) => v.scanStatus !== "infected" && v.scanStatus !== "error");
      if (!bill) throw new ApiError(422, "", ["Upload the customer's energy bill on the Documents tab first."]);
      const r = await api.post<{ reading: BillReading }>(`/document-versions/${bill.id}/read-bill`);
      return { reading: r.reading, uploadedAt: bill.uploadedAt };
    },
  });
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const save = useMutation({ meta: { silent: true }, mutationFn: (body: object) => api.put<V>(endpoint, body), onSuccess: (v) => (onSaved(v), onClose()) });

  // Each read is a paid call: start it once, even when React runs effects twice in development.
  const started = useRef(false);
  const { mutate } = read;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);

  const r = read.data?.reading;
  const rows = r ? suggest(r, data) : [];
  const ticked = chosen ?? new Set(rows.filter((row) => !row.current).map((row) => row.key));
  const toggle = (key: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(key);
    else next.delete(key);
    setChosen(next);
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Fill from bill"
      description={read.data ? `From the bill uploaded ${date(read.data.uploadedAt)}. Check each value against the bill; only ticked values are saved.` : "The AI is reading the customer's latest energy bill."}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {r && rows.length > 0 && (
            <Button loading={save.isPending} disabled={ticked.size === 0} onClick={() => save.mutate(saveFor(r, data, ticked))}>
              Use these details
            </Button>
          )}
        </>
      }
    >
      {read.isPending && (
        <div className="space-y-2" aria-live="polite">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Sparkles className="size-4 text-primary" aria-hidden /> Reading the bill…
          </p>
          <Skeleton className="h-40" />
        </div>
      )}
      {read.error && <IssueList issues={failure(read.error)} title="The bill couldn't be read:" />}
      {r && !r.readable && <IssueList issues={["This doesn't look like an energy bill the AI can read. Fill the form by hand."]} title="Nothing to use:" />}
      {r?.readable && (
        <div className="space-y-4">
          {r.notes && (
            <p className="flex items-start gap-2 rounded-[var(--md-sys-shape-corner-small)] bg-warning-soft p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {r.notes}
            </p>
          )}
          {r.fuel === "gas" && <IssueList issues={["This is a gas bill, so its meter details don't belong on an electricity form."]} title="Check the bill:" />}
          {rows.length === 0 ? (
            <p className="text-sm text-muted">Everything the AI read from the bill is already on the form.</p>
          ) : (
            <div className="overflow-x-auto" tabIndex={0}>
              <table className="w-full min-w-[32rem] text-sm">
                <thead className="text-left text-xs text-muted">
                  <tr>
                    <th className="w-10 py-2 font-medium">
                      <span className="sr-only">Use</span>
                    </th>
                    <th className="py-2 pr-3 font-medium">Field</th>
                    <th className="py-2 pr-3 font-medium">On the bill</th>
                    <th className="py-2 font-medium">On the form now</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.key} className="border-t border-border align-top">
                      <td className="py-1">
                        <Checkbox label={`Use ${row.label}`} className="[&_label>span]:sr-only" checked={ticked.has(row.key)} onChange={(e) => toggle(row.key, e.target.checked)} />
                      </td>
                      <td className="py-2 pr-3">{row.label}</td>
                      <td className="py-2 pr-3 font-medium">{shown(row.proposed)}</td>
                      <td className="py-2 text-muted">{row.current ? shown(row.current) : "Empty"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {stillNeeded.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Still needed before it can be sent for signature (not on a bill)</p>
              <ul className="ml-5 list-disc space-y-0.5 text-sm">
                {stillNeeded.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          {save.error && <IssueList issues={failure(save.error)} title="Nothing was saved:" />}
        </div>
      )}
    </Dialog>
  );
}

/** Issue paths a bill can fill; the rest are listed as still needed. */
export const BILL_FILLABLE = /^(legalName|supplyAddress|meters|readingDate|mprn|mic|annualConsumption|existingSupplier|readings)/;
