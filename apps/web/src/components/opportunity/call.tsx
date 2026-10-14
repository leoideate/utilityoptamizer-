"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Phone, PhoneOff } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CALL_OUTCOMES } from "@uo/shared";
import { Dialog } from "@/components/ui/overlays";
import { Badge, Button, Field, Input, IssueList, Select, Textarea } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { useRealtimeConnected } from "@/lib/realtime";
import type { Workspace } from "@/lib/types";
import { useRefreshOpportunity } from "./common";

interface Telephony {
  provider: "manual" | "ringcentral";
  bridged: boolean;
  myPhone: string | null;
}
interface Call {
  id: string;
  status: string;
  toNumber: string;
  outcome: string | null;
  durationSec: number | null;
  loggedAt: string | null;
}

const OUTCOME_LABELS: Record<(typeof CALL_OUTCOMES)[number], string> = {
  answered: "Answered: we spoke",
  no_answer: "No answer",
  busy: "Busy",
  voicemail: "Left a voicemail",
  wrong_number: "Wrong number",
  call_back_requested: "Asked us to call back",
};

const STATUS_TEXT: Record<string, string> = {
  initiated: "Starting…",
  ringing_agent: "Ringing your phone. Answer it to be connected.",
  ringing_customer: "Calling the customer…",
  in_progress: "Connected",
  completed: "Call ended",
  no_answer: "No answer",
  busy: "Busy",
  failed: "Couldn't connect",
  canceled: "Cancelled",
};
const FINAL = ["completed", "no_answer", "busy", "failed", "canceled"];

/** "Call" button: rings the user's phone via RingCentral, or opens the dialler and records the outcome. */
export function CallButton({ opp }: { opp: Workspace }) {
  const [open, setOpen] = useState(false);
  if (!opp.permissions.write) return null;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Phone /> Call
      </Button>
      {open && <CallDialog opp={opp} onClose={() => setOpen(false)} />}
    </>
  );
}

function CallDialog({ opp, onClose }: { opp: Workspace; onClose: () => void }) {
  const live = useRealtimeConnected();
  const refresh = useRefreshOpportunity(opp.id);
  const qc = useQueryClient();
  const tel = useQuery({ queryKey: ["telephony"], queryFn: () => api.get<Telephony>("/telephony") });
  const numbers = useQuery({ queryKey: ["call-numbers", opp.id], queryFn: () => api.get<{ number: string; label: string; contactId: string | null }[]>(`/opportunities/${opp.id}/call-numbers`) });
  const [number, setNumber] = useState("");
  const [callId, setCallId] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  useEffect(() => {
    if (!number && numbers.data?.length) setNumber(numbers.data[0].number);
  }, [numbers.data, number]);

  const call = useQuery({
    queryKey: ["call", callId],
    queryFn: () => api.get<Call>(`/calls/${callId}`),
    enabled: !!callId,
    // Live updates arrive by event; poll as a fallback, and stop once the call has ended.
    refetchInterval: (q) => (q.state.data && FINAL.includes(q.state.data.status) ? false : live ? 15_000 : 3_000),
  });
  const start = useMutation({
    meta: { silent: true },
    mutationFn: () => api.post<{ call: Call; mode: "manual" | "bridged"; telUri?: string }>(`/opportunities/${opp.id}/calls`, { number }),
    onSuccess: (r) => {
      setIssues([]);
      setCallId(r.call.id);
      qc.setQueryData(["call", r.call.id], r.call);
      if (r.mode === "manual" && r.telUri) window.location.href = r.telUri;
    },
    onError: (e) => setIssues((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  const cancel = useMutation({ mutationFn: () => api.post(`/calls/${callId}/cancel`), onSuccess: () => call.refetch() });

  const manual = tel.data && !tel.data.bridged;
  const status = call.data?.status;
  const ended = !!status && FINAL.includes(status);
  const close = () => {
    refresh();
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={`Call ${opp.customer?.legalName ?? opp.companyName ?? opp.name}`} description={tel.data?.bridged ? "We'll ring your phone first, then connect you to the customer." : "Your phone will dial the number. Afterwards, record how it went."}>
      {!callId ? (
        <div className="space-y-4">
          {!numbers.data?.length ? (
            <p className="text-sm text-muted">There's no phone number saved for this customer yet. Add one to a contact or the opportunity.</p>
          ) : (
            <Field label="Number">
              {(p) => (
                <Select {...p} value={number} onChange={(e) => setNumber(e.target.value)}>
                  {numbers.data.map((n) => (
                    <option key={n.number} value={n.number}>
                      {n.label} · {n.number}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          {tel.data?.bridged && (
            <p className="text-sm">
              {tel.data.myPhone ? (
                <>
                  Your phone: <strong>{tel.data.myPhone}</strong>{" "}
                  <Link href="/account" className="text-primary hover:underline">
                    Change
                  </Link>
                </>
              ) : (
                <>
                  <Link href="/account" className="text-primary underline">
                    Add your phone number
                  </Link>{" "}
                  so we know which phone to ring.
                </>
              )}
            </p>
          )}
          <IssueList issues={issues} title="Can't call yet:" />
          <div className="flex justify-end">
            <Button onClick={() => start.mutate()} loading={start.isPending} disabled={!number || (tel.data?.bridged && !tel.data.myPhone)}>
              <Phone /> {manual ? "Dial on my phone" : "Call now"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {!manual && (
            <div role="status" className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-4 py-3">
              <div>
                <p className="font-medium">{STATUS_TEXT[status ?? "initiated"]}</p>
                <p className="text-sm text-muted">
                  {call.data?.toNumber}
                  {call.data?.outcome && status && FINAL.includes(status) ? ` · ${call.data.outcome}` : ""}
                </p>
              </div>
              {status && ["initiated", "ringing_agent"].includes(status) && (
                <Button size="sm" variant="secondary" onClick={() => cancel.mutate()}>
                  <PhoneOff /> Cancel
                </Button>
              )}
              {ended && <Badge tone={status === "completed" ? "success" : "warning"}>{status === "completed" ? "Logged to timeline" : "Not connected"}</Badge>}
            </div>
          )}
          {(manual || ended) && <OutcomeForm callId={callId} manual={!!manual} onDone={close} />}
        </div>
      )}
    </Dialog>
  );
}

function OutcomeForm({ callId, manual, onDone }: { callId: string; manual: boolean; onDone: () => void }) {
  const [outcome, setOutcome] = useState<(typeof CALL_OUTCOMES)[number]>("answered");
  const [minutes, setMinutes] = useState("");
  const [notes, setNotes] = useState("");
  const save = useMutation({
    mutationFn: () => api.post(`/calls/${callId}/outcome`, { outcome, durationMinutes: minutes ? Number(minutes) : null, notes: notes || null }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{manual ? "How did the call go?" : "Add notes (optional)"}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Outcome">
          {(p) => (
            <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
              {CALL_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {OUTCOME_LABELS[o]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {manual && <Field label="Length (minutes)">{(p) => <Input {...p} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ""))} />}</Field>}
      </div>
      <Field label="Notes">{(p) => <Textarea {...p} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was agreed, next steps…" />}</Field>
      <div className="flex justify-end gap-2">
        {!manual && (
          <Button variant="ghost" onClick={onDone}>
            Skip
          </Button>
        )}
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Save to timeline
        </Button>
      </div>
    </div>
  );
}
