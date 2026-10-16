"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, CheckCircle2, Circle } from "lucide-react";
import { useRef, useState } from "react";
import { DOCUMENT_TYPES, type DocumentType, isHandedOver } from "@uo/shared";
import { Button, Card, CardHeader, IssueList } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { date } from "@/lib/format";
import type { Workspace } from "@/lib/types";
import { useRefreshOpportunity } from "./common";

interface Item {
  id: string;
  documentType: DocumentType;
  required: boolean;
  received: boolean;
  receivedAt: string | null;
}

/** What a salesperson or field agent photographs at the customer's premises. */
const ON_SITE: { type: DocumentType; hint: string }[] = [
  { type: "energy_bill", hint: "The customer's current bill (all pages)." },
  { type: "meter_reading_photo", hint: "The meter with today's reading visible." },
];

/**
 * Sales and field agents: capture the bill and meter photo straight from a phone camera, and see
 * which customer documents are still missing before the back office takes over.
 */
export function CollectCard({ opp }: { opp: Workspace }) {
  const docs = useQuery({ queryKey: ["opportunity", opp.id, "documents"], queryFn: () => api.get<Item[]>(`/opportunities/${opp.id}/documents`) });
  if (!opp.permissions.write || opp.outcome !== "open") return null;
  const missing = (docs.data ?? []).filter((d) => d.required && !d.received && !ON_SITE.some((o) => o.type === d.documentType));
  return (
    <Card>
      <CardHeader
        title="Collect from the customer"
        description={isHandedOver(opp.stage.key) ? "The back office has this deal; upload anything the customer still owes." : "Photograph these on site; they go straight onto this deal."}
      />
      <ul className="divide-y divide-border">
        {ON_SITE.map((o) => (
          <CaptureRow key={o.type} opp={opp} type={o.type} hint={o.hint} item={docs.data?.find((d) => d.documentType === o.type)} />
        ))}
      </ul>
      {missing.length > 0 && (
        <p className="border-t border-border px-5 py-3 text-sm text-muted">
          Also still needed: {missing.map((d) => (DOCUMENT_TYPES as Record<string, { label: string }>)[d.documentType]?.label ?? d.documentType).join(", ")} (under Documents).
        </p>
      )}
    </Card>
  );
}

function CaptureRow({ opp, type, hint, item }: { opp: Workspace; type: DocumentType; hint: string; item?: Item }) {
  const qc = useQueryClient();
  const refresh = useRefreshOpportunity(opp.id);
  const input = useRef<HTMLInputElement>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const label = DOCUMENT_TYPES[type].label;
  const upload = useMutation({
    meta: { silent: true },
    mutationFn: async (file: File) => {
      const itemId = item?.id ?? (await api.post<{ id: string }>(`/opportunities/${opp.id}/documents`, { documentType: type, required: true })).id;
      return api.upload(`/documents/${itemId}/versions`, file);
    },
    onSuccess: () => (setIssues([]), qc.invalidateQueries({ queryKey: ["opportunity", opp.id, "documents"] }), refresh()),
    onError: (e) => setIssues((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <li className="space-y-2 px-5 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {item?.received ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <Circle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />}
          <span className="min-w-0">
            <span className="font-medium">{label}</span>
            <span className="sr-only">{item?.received ? " (received)" : " (missing)"}</span>
            <span className="block text-xs text-muted">{item?.received ? `Received ${date(item.receivedAt)}` : hint}</span>
          </span>
        </div>
        <Button size="sm" variant={item?.received ? "secondary" : "primary"} loading={upload.isPending} onClick={() => input.current?.click()}>
          <Camera /> {item?.received ? "Add a newer copy" : "Take photo or upload"}
        </Button>
        <input
          ref={input}
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          className="sr-only"
          aria-label={`Upload ${label}`}
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) upload.mutate(f);
          }}
        />
      </div>
      <IssueList issues={issues} title="Not uploaded:" />
    </li>
  );
}
