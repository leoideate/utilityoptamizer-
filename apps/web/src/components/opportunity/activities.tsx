"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, Plus } from "lucide-react";
import { useState } from "react";
import { ActivityDialog } from "@/components/activity-form";
import { ActivityList, type ActivityRow } from "@/components/activity-list";
import { Button, Card, CardHeader, EmptyState, Select, Skeleton } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import type { Page, Workspace } from "@/lib/types";
import { useRefreshOpportunity } from "./common";

export function ActivitiesTab({ opp }: { opp: Workspace }) {
  const [status, setStatus] = useState<"open" | "done" | "cancelled">("open");
  const [adding, setAdding] = useState(false);
  const refresh = useRefreshOpportunity(opp.id);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["activities", "opportunity", opp.id, status],
    queryFn: () => api.get<Page<ActivityRow>>(`/activities?opportunityId=${opp.id}&status=${status}&pageSize=200`),
  });
  return (
    <Card>
      <CardHeader
        title="Tasks"
        description="Calls, follow-ups and reminders for this opportunity. Automatic tasks are created by the system and close themselves when done."
        actions={
          <>
            <Select className="w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Show">
              <option value="open">Open</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </Select>
            {opp.permissions.write && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus /> Add task
              </Button>
            )}
          </>
        }
      />
      {isLoading || !data ? <Skeleton className="m-5 h-32" /> : !data.items.length ? <EmptyState icon={<CalendarCheck />} title={status === "open" ? "Nothing to do" : "None"} /> : <ActivityList items={data.items} onChange={() => (refresh(), refetch())} />}
      {adding && <ActivityDialog opportunityId={opp.id} customerId={opp.customerId} onClose={(saved) => (setAdding(false), saved && (refresh(), refetch()))} />}
    </Card>
  );
}
