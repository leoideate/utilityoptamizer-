"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Save, ShieldCheck, Sparkles, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  APPLICATION_STATUS_LABELS,
  type ApplicationStatus,
  BORD_GAIS_TABS,
  BORD_GAIS_TAB_LABELS,
  type BordGaisElectricityData,
  type BordGaisTab,
  type FormSignerRole,
  bordGaisContactName,
  bordGaisElectricityIssues,
  bordGaisFillSave,
  bordGaisFillSuggestions,
} from "@uo/shared";
import { TabPanel, Tabs } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, IssueList, Skeleton, type Tone } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/session";
import type { Workspace } from "@/lib/types";
import { useRefreshOpportunity } from "../common";
import { DocumentPanel } from "../supplier-application/document-panel";
import { TabSummary } from "../supplier-application/fields";
import { BILL_FILLABLE, FillFromBillDialog } from "../supplier-application/fill-from-bill";
import type { BankEdit } from "../supplier-application/types";
import { AccountTab, AgreementTab, DebitTab, DeclarationTab, PremisesTab, SupplyTab } from "./bord-gais-fields";
import { type BordGaisView, forValidation, isEmptyPayload, savePayload } from "./draft";

const STATUS_TONE: Record<ApplicationStatus, Tone> = { draft: "neutral", ready: "info", sent: "info", viewed: "warning", signed: "warning", declined: "danger", expired: "neutral", completed: "success", rejected: "danger" };
const issuesOf = (e: unknown) => ((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]);

/**
 * The Bord Gáis Electricity Form: shown when Electricity is a product of interest and Bord Gáis
 * Energy is the selected supplier. Edits are kept here until "Save draft", which writes them to the
 * CRM records they belong to; the PDF is generated from what's saved.
 */
export function BordGaisTab({ opp }: { opp: Workspace }) {
  const qc = useQueryClient();
  const refreshOpp = useRefreshOpportunity(opp.id);
  const base = `/opportunities/${opp.id}/bord-gais-electricity`;
  const key = ["opportunity", opp.id, "bord-gais"];
  const view = useQuery({ queryKey: key, queryFn: () => api.get<BordGaisView>(base) });
  // `saved` is what the draft started from: a refresh while there are unsaved edits must not undo them.
  const [saved, setSaved] = useState<BordGaisElectricityData | null>(null);
  const [draft, setDraft] = useState<BordGaisElectricityData | null>(null);
  const [bank, setBank] = useState<BankEdit | null>(null);
  const [confirmIban, setConfirmIban] = useState(false);
  const [tab, setTab] = useState<BordGaisTab>("account");
  const [showErrors, setShowErrors] = useState(false);
  const [saveIssues, setSaveIssues] = useState<string[]>([]);
  const [validated, setValidated] = useState(false);
  const [filling, setFilling] = useState(false);
  const aiReading = useUser().features.aiReading;

  const dirty = !!saved && !!draft && !isEmptyPayload(savePayload(saved, draft, bank, confirmIban));
  useEffect(() => {
    if (!view.data) return;
    if (!dirty) {
      setSaved(view.data.data);
      setDraft(view.data.data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only new server data should reset an unchanged draft
  }, [view.data]);

  const issues = useMemo(() => (draft ? bordGaisElectricityIssues(forValidation(draft, bank)) : []), [draft, bank]);
  const byTab = (t: BordGaisTab) => issues.filter((i) => i.tab === t);
  const refresh = () => (qc.invalidateQueries({ queryKey: key }), refreshOpp());

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => api.put<BordGaisView>(base, savePayload(saved!, draft!, bank, confirmIban)),
    onSuccess: (v) => {
      qc.setQueryData(key, v);
      setSaved(v.data);
      setDraft(v.data);
      setBank(null);
      setConfirmIban(false);
      setSaveIssues([]);
      refreshOpp();
    },
    onError: (e) => setSaveIssues(issuesOf(e)),
  });
  const createCustomer = useMutation({ mutationFn: () => api.post(`/opportunities/${opp.id}/customer/create`), onSuccess: refresh });

  if (view.isLoading || (view.data && !draft)) return <Skeleton className="h-96" />;
  if (view.isError || !view.data || !draft) return <Card className="p-5 text-sm text-danger">The Bord Gáis form couldn&apos;t be loaded. Reload the page to try again.</Card>;
  const v = view.data;
  if (!v.applies) {
    return <Card className="p-5 text-sm text-muted">The Bord Gáis electricity form applies when Electricity is a product of interest and Bord Gáis Energy is the selected supplier. Anything saved earlier is kept.</Card>;
  }
  if (v.needsCustomer) {
    return (
      <Card>
        <CardHeader title="Bord Gáis Electricity Form" description="The form is filled from the customer's record, so the customer needs to exist first." />
        <div className="p-5">
          {opp.permissions.write && (
            <Button loading={createCustomer.isPending} onClick={() => createCustomer.mutate()}>
              <UserPlus /> Create the customer from this deal
            </Button>
          )}
        </div>
      </Card>
    );
  }

  const ro = !v.permissions.write;
  const set = (patch: Partial<BordGaisElectricityData>) => (setDraft({ ...draft, ...patch }), setValidated(false));
  const err = (path: string) => (showErrors ? issues.find((i) => i.path === path)?.message : undefined);
  const props = { view: v, d: draft, set, err, ro };
  const validate = () => {
    setShowErrors(true);
    setValidated(true);
    const first = BORD_GAIS_TABS.find((t) => byTab(t).length);
    if (first) setTab(first);
  };
  const signerDefaults = (role: FormSignerRole) =>
    role === "account_holder_2" ? { name: draft.secondAccountHolder?.name ?? "", email: draft.secondAccountHolder?.email ?? "" } : { name: draft.signatoryName ?? bordGaisContactName(draft) ?? "", email: draft.email ?? "" };

  return (
    <div className="space-y-4">
      {filling && (
        <FillFromBillDialog<typeof v.data, BordGaisView>
          opportunityId={opp.id}
          endpoint={base}
          data={v.data}
          suggest={bordGaisFillSuggestions}
          saveFor={bordGaisFillSave}
          stillNeeded={v.issues.filter((i) => !BILL_FILLABLE.test(i.path)).map((i) => i.message)}
          onSaved={(saved) => {
            qc.setQueryData(key, saved);
            setSaved(saved.data);
            setDraft(saved.data);
            refreshOpp();
          }}
          onClose={() => setFilling(false)}
        />
      )}
      <Card>
        <CardHeader
          title="Bord Gáis Electricity Form"
          description="Business Electricity Customer Agreement and SEPA Direct Debit Mandate, filled from this deal. Saving writes each detail back to the customer, site, meter and contract records."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[v.status]}>{APPLICATION_STATUS_LABELS[v.status]}</Badge>
              {dirty && <Badge tone="warning">Unsaved changes</Badge>}
              <Button size="sm" variant="secondary" onClick={validate}>
                <ShieldCheck /> Validate application
              </Button>
              {!ro && aiReading && (
                <Button size="sm" variant="secondary" disabled={dirty} title={dirty ? "Save or undo your changes first" : undefined} onClick={() => setFilling(true)}>
                  <Sparkles /> Fill from bill
                </Button>
              )}
              {!ro && (
                <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
                  <Save /> Save draft
                </Button>
              )}
            </div>
          }
        />
        {(saveIssues.length > 0 || validated) && (
          <div className="space-y-2 px-5 pb-4">
            <IssueList issues={saveIssues} title="The draft wasn't saved:" />
            {validated &&
              (issues.length ? (
                <p className="text-sm text-warning" role="status">
                  {issues.length} thing{issues.length === 1 ? "" : "s"} to complete before it can be sent for signature: see the tabs marked with a count.
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-sm text-success" role="status">
                  <CheckCircle2 className="size-4" aria-hidden /> Everything the form needs is filled in{dirty ? ". Save the draft, then generate the PDF." : "."}
                </p>
              ))}
          </div>
        )}
      </Card>

      <Tabs value={tab} onValueChange={(t) => setTab(t as BordGaisTab)} tabs={BORD_GAIS_TABS.map((t) => ({ value: t, label: `${BORD_GAIS_TAB_LABELS[t]}${showErrors && byTab(t).length ? ` (${byTab(t).length})` : ""}` }))}>
        <TabPanel value="account">
          <AccountTab {...props} issues={showErrors ? byTab("account") : []} />
        </TabPanel>
        <TabPanel value="premises">
          <PremisesTab {...props} issues={showErrors ? byTab("premises") : []} />
        </TabPanel>
        <TabPanel value="supply">
          <SupplyTab {...props} issues={showErrors ? byTab("supply") : []} />
        </TabPanel>
        <TabPanel value="agreement">
          <AgreementTab {...props} issues={showErrors ? byTab("agreement") : []} />
        </TabPanel>
        <TabPanel value="declaration">
          <DeclarationTab {...props} issues={showErrors ? byTab("declaration") : []} />
        </TabPanel>
        <TabPanel value="debit">
          <DebitTab {...props} issues={showErrors ? byTab("debit") : []} bank={bank} setBank={(b) => (setBank(b), setValidated(false))} confirmIban={confirmIban} setConfirmIban={setConfirmIban} />
        </TabPanel>
        <TabPanel value="documents">
          <div className="space-y-4">
            <TabSummary issues={showErrors ? byTab("documents") : []} />
            <DocumentPanel
              base={base}
              formLabel="the Bord Gáis form"
              missingTemplate="The Bord Gáis electricity form hasn't been set up yet. An administrator needs to upload the Bord Gáis Business Electricity Customer Agreement Form under Admin → Supplier forms."
              view={v}
              dirty={dirty}
              hasIssues={issues.length > 0 || v.issues.length > 0}
              onInvalid={validate}
              refresh={refresh}
              signerDefaults={signerDefaults}
            />
          </div>
        </TabPanel>
      </Tabs>
    </div>
  );
}
