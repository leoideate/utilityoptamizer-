"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Tabs, TabPanel } from "@/components/ui/overlays";
import { Card, CardHeader } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { ref } from "@/lib/format";

interface AttentionItem {
  id: string;
  number: number | null;
  name: string;
  stage: string | null;
  days: number;
  link: string;
  summary?: string;
}
interface AttentionList {
  items: AttentionItem[];
  total: number;
}
type ListKey = "stuck" | "overdueTasks" | "followUps" | "renewals";
type Attention = Record<ListKey, AttentionList>;

const LISTS: { key: ListKey; label: string; more?: string; when: (d: number) => string }[] = [
  { key: "stuck", label: "Stuck deals", when: (d) => `${d} days at this stage, nothing planned` },
  { key: "overdueTasks", label: "Overdue tasks", more: "/activities", when: (d) => `${d} day${d === 1 ? "" : "s"} overdue` },
  { key: "followUps", label: "Follow-ups due", when: (d) => (d === 0 ? "Follow up today" : `Follow-up ${d} day${d === 1 ? "" : "s"} late`) },
  { key: "renewals", label: "Renewals due", more: "/opportunities?view=renewals_due", when: (d) => (d < 0 ? `Renewal date passed ${-d} days ago` : d === 0 ? "Renews today" : `Renews in ${d} days`) },
];

/** Home: stuck deals, overdue tasks, follow-ups and renewals for the signed-in user. Hidden when there's nothing. */
export function NeedsAttention() {
  const { data } = useQuery({ queryKey: ["attention"], queryFn: () => api.get<Attention>("/attention") });
  const [tab, setTab] = useState<ListKey | null>(null);
  const shown = LISTS.filter((l) => data?.[l.key].total);
  if (!data || !shown.length) return null;
  const active = shown.find((l) => l.key === tab) ?? shown[0];

  return (
    <Card className="mb-6" aria-label="Needs your attention">
      <CardHeader title="Needs your attention" description="Deals that have gone quiet, tasks past their date, follow-ups and renewals coming up." />
      <div className="px-5 pb-4">
        <Tabs value={active.key} onValueChange={(v) => setTab(v as ListKey)} tabs={shown.map((l) => ({ value: l.key, label: `${l.label} (${data[l.key].total})` }))}>
          {shown.map((l) => (
            <TabPanel key={l.key} value={l.key}>
              <ul className="divide-y divide-border">
                {data[l.key].items.map((i) => (
                  <li key={`${i.id}-${i.summary ?? ""}`}>
                    <Link href={i.link} className="flex min-h-12 items-center gap-3 rounded-lg py-2 outline-offset-2 hover:bg-surface-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {i.number != null && <span className="tabular mr-2 text-muted">{ref(i.number)}</span>}
                          {i.name}
                        </p>
                        <p className="text-xs text-muted">{[i.summary, i.stage, l.when(i.days)].filter(Boolean).join(" · ")}</p>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
              {data[l.key].total > data[l.key].items.length && (
                <p className="pt-3 text-sm text-muted">
                  Showing {data[l.key].items.length} of {data[l.key].total}.
                  {l.more && (
                    <>
                      {" "}
                      <Link href={l.more} className="text-primary hover:underline">
                        See all
                      </Link>
                    </>
                  )}
                </p>
              )}
            </TabPanel>
          ))}
        </Tabs>
      </div>
    </Card>
  );
}
