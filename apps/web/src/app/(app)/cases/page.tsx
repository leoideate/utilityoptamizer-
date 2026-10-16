"use client";

import { useQuery } from "@tanstack/react-query";
import { ClipboardList } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CASE_KINDS, CASE_KIND_LABELS, type CaseKind } from "@uo/shared";
import { useAssignableUsers } from "@/components/domain";
import { Badge, Card, EmptyState, Field, Input, PageHeader, Select, Skeleton, Stat, type Tone } from "@/components/ui/primitives";
import { api, qs } from "@/lib/api";
import { cn, date, ref, todayIso } from "@/lib/format";

type Bucket = "in_progress" | "overdue" | "awaiting_approval" | "ready" | "sent_awaiting" | "accepted" | "rejected" | "completed";
interface CaseRow {
  id: string;
  number: number;
  name: string;
  customer: string | null;
  kind: CaseKind;
  kindLabel: string;
  status: string;
  bucket: Bucket;
  due: string | null;
  owner: { id: string; name: string } | null;
  supplier: { id: string; name: string } | null;
}

const BUCKETS: { key: Bucket; label: string; tone: Tone }[] = [
  { key: "overdue", label: "Overdue", tone: "danger" },
  { key: "in_progress", label: "In progress", tone: "neutral" },
  { key: "awaiting_approval", label: "Awaiting client or broker", tone: "warning" },
  { key: "ready", label: "Ready to send", tone: "info" },
  { key: "sent_awaiting", label: "Sent, no acknowledgement", tone: "warning" },
  { key: "accepted", label: "Accepted", tone: "success" },
  { key: "rejected", label: "Rejected or changes required", tone: "danger" },
  { key: "completed", label: "Completed (90 days)", tone: "success" },
];
const toneOf = (b: Bucket) => BUCKETS.find((x) => x.key === b)!.tone;
const labelOf = (b: Bucket) => BUCKETS.find((x) => x.key === b)!.label;

/** Back-office cases (renewals, changes of entity and supplier) by where they stand. */
export default function CasesPage() {
  const [kind, setKind] = useState<CaseKind | "">("");
  const [ownerId, setOwnerId] = useState("");
  const [dueBefore, setDueBefore] = useState("");
  const [bucket, setBucket] = useState<Bucket | "">("");
  const users = useAssignableUsers();
  const query = qs({ kind: kind || undefined, ownerId: ownerId || undefined, dueBefore: dueBefore || undefined });
  const { data, isLoading } = useQuery({ queryKey: ["cases", query], queryFn: () => api.get<{ counts: Record<Bucket, number>; rows: CaseRow[]; capped: boolean }>(`/cases${query}`), placeholderData: (p) => p });
  const rows = data?.rows.filter((r) => !bucket || r.bucket === bucket) ?? [];
  const today = todayIso();

  return (
    <>
      <PageHeader title="Cases" description="Renewals, changes of entity and changes of supplier, from the request to the external party's acceptance." />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as CaseKind | "")}>
              <option value="">All energy cases</option>
              {CASE_KINDS.filter((k) => k !== "merchant").map((k) => (
                <option key={k} value={k}>
                  {CASE_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Owner">
          {(p) => (
            <Select {...p} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">Anyone</option>
              {users.data?.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Due by">{(p) => <Input {...p} type="date" value={dueBefore} onChange={(e) => setDueBefore(e.target.value)} />}</Field>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            aria-pressed={bucket === b.key}
            onClick={() => setBucket(bucket === b.key ? "" : b.key)}
            className={cn("min-w-0 rounded-xl text-left outline-offset-2", bucket === b.key && "ring-2 ring-primary")}
          >
            <Stat label={b.label} value={data?.counts[b.key] ?? "—"} tone={data?.counts[b.key] ? b.tone : undefined} />
          </button>
        ))}
      </div>
      <Card className="overflow-hidden">
        {isLoading ? (
          <Skeleton className="m-4 h-48" />
        ) : !rows.length ? (
          <EmptyState icon={<ClipboardList />} title="No cases here" />
        ) : (
          <>
            <ul className="divide-y divide-border md:hidden">
              {rows.map((r) => (
                <li key={r.id}>
                  <Link href={`/opportunities/${r.id}`} className="block px-4 py-3 active:bg-surface-2">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 font-medium">{r.customer ?? r.name}</span>
                      <Badge tone={toneOf(r.bucket)}>{r.status}</Badge>
                    </div>
                    <p className="text-xs text-muted">
                      {ref(r.number)} · {r.kindLabel}
                      {r.due && ` · due ${date(r.due)}`}
                      {r.owner && ` · ${r.owner.name}`}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="hidden overflow-x-auto md:block" tabIndex={0}>
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-surface-2 text-left text-muted">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Case</th>
                    <th className="px-3 py-2.5 font-medium">Kind</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Due</th>
                    <th className="px-3 py-2.5 font-medium">Supplier</th>
                    <th className="px-4 py-2.5 font-medium">Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-t border-border hover:bg-surface-2/60">
                      <td className="px-4 py-2.5">
                        <Link href={`/opportunities/${r.id}`} className="inline-block py-0.5 font-medium hover:underline">
                          {r.customer ?? r.name}
                        </Link>
                        <span className="block text-xs text-muted">{ref(r.number)}</span>
                      </td>
                      <td className="px-3 py-2.5">{r.kindLabel}</td>
                      <td className="px-3 py-2.5">
                        <Badge tone={toneOf(r.bucket)}>{r.status}</Badge>
                        <span className="sr-only"> ({labelOf(r.bucket)})</span>
                      </td>
                      <td className={cn("px-3 py-2.5", r.due && r.due < today && r.bucket !== "completed" && "font-medium text-danger")}>{r.due ? date(r.due) : "—"}</td>
                      <td className="px-3 py-2.5">{r.supplier?.name ?? "—"}</td>
                      <td className="px-4 py-2.5">{r.owner?.name ?? "Unassigned"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>
      {data?.capped && <p className="mt-2 text-xs text-muted">Showing the 200 most recently updated cases. Filter to narrow the list.</p>}
    </>
  );
}
