"use client";

import type { FormSignerRole } from "@uo/shared";
import { Card, CardHeader, Checkbox, Field, Input } from "@/components/ui/primitives";
import { DocumentPanel } from "../supplier-application/document-panel";
import { TabSummary } from "../supplier-application/fields";
import { type TabProps } from "./flogas-fields";

export function DocumentsTab({ view, d, set, err, issues, ro, opportunityId, dirty, onInvalid, refresh }: TabProps & { opportunityId: string; dirty: boolean; onInvalid: () => void; refresh: () => void }) {
  return (
    <div className="space-y-4">
      <TabSummary issues={issues} />
      <Card>
        <CardHeader title="Customer agreement" description="Who signs for the customer. Their signature and the date are added when they sign." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Signatory name (block capitals on the form)" error={err("signatoryName")} hint={view.answered.includes("signatoryName") ? undefined : "From the account contact until you change it."}>
            {(p) => <Input {...p} maxLength={120} disabled={ro} value={d.signatoryName ?? ""} onChange={(e) => set({ signatoryName: e.target.value || null })} />}
          </Field>
          <Field label="Position held at company" error={err("signatoryPosition")}>
            {(p) => <Input {...p} maxLength={80} disabled={ro} value={d.signatoryPosition ?? ""} onChange={(e) => set({ signatoryPosition: e.target.value || null })} />}
          </Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Agency details" description="From the CRM: the agency ID is set on the Flogas supplier, the agency name in the broker profile and the agent is the deal's salesperson." />
        <div className="grid gap-4 p-5 sm:grid-cols-3">
          <Field label="Agency ID">{(p) => <Input {...p} disabled value={d.agencyId ?? "Not set"} />}</Field>
          <Field label="Agency name / stamp">{(p) => <Input {...p} disabled value={d.agencyName ?? ""} />}</Field>
          <Field label="Agent name">{(p) => <Input {...p} disabled value={d.agentName ?? "Unassigned"} />}</Field>
          <div className="sm:col-span-3">
            <Checkbox label="The agent signs the form too (in the agency stamp box)" checked={d.agentSignature} disabled={ro} onChange={(e) => set({ agentSignature: e.target.checked })} />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="Signed on behalf of Flogas" description="Completed by Flogas. Leave blank unless Flogas has asked you to record these." />
        <div className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Flogas representative name">{(p) => <Input {...p} maxLength={120} disabled={ro} value={d.flogasRepName ?? ""} onChange={(e) => set({ flogasRepName: e.target.value || null })} />}</Field>
          <Field label="Date of activation">{(p) => <Input {...p} type="date" disabled={ro} value={d.flogasActivationDate ?? ""} onChange={(e) => set({ flogasActivationDate: e.target.value || null })} />}</Field>
          <p className="text-sm text-muted sm:col-span-2">The Flogas signature box is never filled by the CRM.</p>
        </div>
      </Card>

      <DocumentPanel
        base={`/opportunities/${opportunityId}/flogas-electricity`}
        formLabel="the Flogas form"
        missingTemplate="The Flogas electricity form hasn't been set up yet. An administrator needs to upload the Flogas Commercial Agreement PDF under Admin → Supplier forms."
        view={view}
        dirty={dirty}
        hasIssues={issues.length > 0}
        onInvalid={onInvalid}
        refresh={refresh}
        signerDefaults={(role: FormSignerRole) =>
          role === "customer" ? { name: d.signatoryName ?? "", email: d.email ?? "" } : role === "account_holder_2" ? { name: d.secondAccountHolder?.name ?? "", email: d.secondAccountHolder?.email ?? "" } : { name: d.agentName ?? "", email: "" }
        }
      />
    </div>
  );
}
