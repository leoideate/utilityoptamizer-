"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Save, Sparkles, UserPlus } from "lucide-react";
import { useEffect, useState } from "react";
import { FLOGAS_STATUS_LABELS, FLOGAS_TAB_LABELS, type FlogasElectricityData, type FlogasIssue, type FlogasStatus, type FlogasTab, flogasFillSave, flogasFillSuggestions } from "@uo/shared";
import { TabPanel, Tabs } from "@/components/ui/overlays";
import { Badge, Button, Card, CardHeader, IssueList, Skeleton, type Tone } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { useUser } from "@/lib/session";
import type { Workspace } from "@/lib/types";
import { useRefreshOpportunity } from "../common";
import { BILL_FILLABLE, FillFromBillDialog } from "../supplier-application/fill-from-bill";
import { type BankEdit, type FlogasView, isEmptyPayload, savePayload } from "./draft";
import { DocumentsTab } from "./flogas-documents";
import { CustomerTab, DebitTab, PricingTab, SupplyTab, TAB_ORDER } from "./flogas-fields";

const STATUS_TONE: Record<FlogasStatus, Tone> = { draft: "neutral", ready: "info", sent: "info", viewed: "warning", signed: "warning", declined: "danger", expired: "neutral", completed: "success", rejected: "danger" };
const issuesOf = (e: unknown) => ((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]);

/**
 * The Flogas Electricity Form: shown when Electricity is a product of interest and Flogas is the
 * selected supplier. Edits are kept here until "Save draft", which writes them to the CRM records
 * they belong to; the PDF is generated from what's saved.
 */
export function FlogasTab({ opp }: { opp: Workspace }) {
  const qc = useQueryClient();
  const refreshOpp = useRefreshOpportunity(opp.id);
  const key = ["opportunity", opp.id, "flogas"];
  const view = useQuery({ queryKey: key, queryFn: () => api.get<FlogasView>(`/opportunities/${opp.id}/flogas-electricity`) });
  // `base` is what the draft started from: a refresh while there are unsaved edits must not undo them.
  const [base, setBase] = useState<FlogasElectricityData | null>(null);
  const [draft, setDraft] = useState<FlogasElectricityData | null>(null);
  const [bank, setBank] = useState<BankEdit | null>(null);
  const [confirmIban, setConfirmIban] = useState(false);
  const [tab, setTab] = useState<FlogasTab>("customer");
  const [showErrors, setShowErrors] = useState(false);
  const [saveIssues, setSaveIssues] = useState<string[]>([]);
  const [validated, setValidated] = useState(false);
  const [filling, setFilling] = useState(false);
  const aiReading = useUser().features.aiReading;

  const dirty = !!base && !!draft && !isEmptyPayload(savePayload(base, draft, bank, confirmIban));
  useEffect(() => {
    if (!view.data) return;
    if (!dirty) {
      setBase(view.data.data);
      setDraft(view.data.data);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only new server data should reset an unchanged draft
  }, [view.data]);

  // No mandatory fields: the team asked for the form to be generated with whatever is filled in.
  const issues: FlogasIssue[] = [];
  const byTab = (t: FlogasTab) => issues.filter((i) => i.tab === t);
  const refresh = () => (qc.invalidateQueries({ queryKey: key }), refreshOpp());

  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => api.put<FlogasView>(`/opportunities/${opp.id}/flogas-electricity`, savePayload(base!, draft!, bank, confirmIban)),
    onSuccess: (v) => {
      qc.setQueryData(key, v);
      setBase(v.data);
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
  if (view.isError || !view.data || !draft) return <Card className="p-5 text-sm text-danger">The Flogas form couldn&apos;t be loaded. Reload the page to try again.</Card>;
  const v = view.data;
  if (!v.applies) {
    return <Card className="p-5 text-sm text-muted">The Flogas electricity form applies when Electricity is a product of interest and Flogas is the selected supplier. Anything saved earlier is kept.</Card>;
  }
  if (v.needsCustomer) {
    return (
      <Card>
        <CardHeader title="Flogas Electricity Form" description="The form is filled from the customer's record, so the customer needs to exist first." />
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
  const set = (patch: Partial<FlogasElectricityData>) => (setDraft({ ...draft, ...patch }), setValidated(false));
  const err = (path: string) => (showErrors ? issues.find((i) => i.path === path)?.message : undefined);
  const props = { view: v, d: draft, set, err, ro };
  const validate = () => {
    setShowErrors(true);
    setValidated(true);
    const first = TAB_ORDER.find((t) => byTab(t).length);
    if (first) setTab(first);
  };

  return (
    <div className="space-y-4">
      {filling && (
        <FillFromBillDialog<typeof v.data, FlogasView>
          opportunityId={opp.id}
          endpoint={`/opportunities/${opp.id}/flogas-electricity`}
          data={v.data}
          suggest={flogasFillSuggestions}
          saveFor={flogasFillSave}
          stillNeeded={v.issues.filter((i) => !BILL_FILLABLE.test(i.path)).map((i) => i.message)}
          onSaved={(saved) => {
            qc.setQueryData(key, saved);
            setBase(saved.data);
            setDraft(saved.data);
            refreshOpp();
          }}
          onClose={() => setFilling(false)}
        />
      )}
      <Card>
        <CardHeader
          title="Flogas Electricity Form"
          description="Commercial Agreement and SEPA Direct Debit Mandate, filled from this deal. Saving writes each detail back to the customer, site, meter and contract records."
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={STATUS_TONE[v.status]}>{FLOGAS_STATUS_LABELS[v.status]}</Badge>
              {dirty && <Badge tone="warning">Unsaved changes</Badge>}
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

      <Tabs
        value={tab}
        onValueChange={(t) => setTab(t as FlogasTab)}
        tabs={TAB_ORDER.map((t) => ({ value: t, label: `${FLOGAS_TAB_LABELS[t]}${showErrors && byTab(t).length ? ` (${byTab(t).length})` : ""}` }))}
      >
        <TabPanel value="customer">
          <CustomerTab {...props} issues={showErrors ? byTab("customer") : []} />
        </TabPanel>
        <TabPanel value="supply">
          <SupplyTab {...props} issues={showErrors ? byTab("supply") : []} />
        </TabPanel>
        <TabPanel value="pricing">
          <PricingTab {...props} issues={showErrors ? byTab("pricing") : []} />
        </TabPanel>
        <TabPanel value="debit">
          <DebitTab {...props} issues={showErrors ? byTab("debit") : []} bank={bank} setBank={(b) => (setBank(b), setValidated(false))} confirmIban={confirmIban} setConfirmIban={setConfirmIban} />
        </TabPanel>
        <TabPanel value="documents">
          <DocumentsTab {...props} issues={showErrors ? byTab("documents") : []} opportunityId={opp.id} dirty={dirty} onInvalid={validate} refresh={refresh} />
        </TabPanel>
      </Tabs>
    </div>
  );
}
