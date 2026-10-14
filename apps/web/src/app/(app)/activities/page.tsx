"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, Plus } from "lucide-react";
import { useState } from "react";
import { ActivityDialog } from "@/components/activity-form";
import { ActivityList, type ActivityRow } from "@/components/activity-list";
import { Button, Card, EmptyState, PageHeader, Select, Skeleton } from "@/components/ui/primitives";
import { api, qs } from "@/lib/api";
import { useCan } from "@/lib/session";
import type { Page } from "@/lib/types";

export default function ActivitiesPage() {
  const can = useCan();
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const [due, setDue] = useState("");
  const [status, setStatus] = useState("open");
  const [adding, setAdding] = useState(false);
  const query = qs({ scope, due, status, pageSize: 200 });
  const { data, isLoading, refetch } = useQuery({ queryKey: ["activities", query], queryFn: () => api.get<Page<ActivityRow>>(`/activities${query}`) });

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Calls, follow-ups and reminders, soonest first."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus /> New task
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {can("opportunity.read_all") && (
          <Select className="w-auto" value={scope} onChange={(e) => setScope(e.target.value as "mine")} aria-label="Whose tasks">
            <option value="mine">My tasks</option>
            <option value="team">Everyone's tasks</option>
          </Select>
        )}
        <Select className="w-auto" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due">
          <option value="">Any date</option>
          <option value="overdue">Overdue</option>
          <option value="today">Due today</option>
          <option value="week">Next 7 days</option>
        </Select>
        <Select className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="open">Open</option>
          <option value="done">Done</option>
          <option value="cancelled">Cancelled</option>
        </Select>
      </div>
      <Card>
        {isLoading || !data ? (
          <Skeleton className="m-5 h-48" />
        ) : !data.items.length ? (
          <EmptyState icon={<CalendarCheck />} title={status === "open" ? "You're all caught up" : "Nothing here"}>
            {status === "open" ? "New tasks appear here as leads come in and deals move forward." : undefined}
          </EmptyState>
        ) : (
          <ActivityList items={data.items} showOpportunity onChange={refetch} />
        )}
      </Card>
      {adding && <ActivityDialog onClose={(saved) => (setAdding(false), saved && refetch())} />}
    </>
  );
}
