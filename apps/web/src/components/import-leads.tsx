"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { SELECTABLE_SERVICE_TYPES, SERVICE_TYPE_LABELS, type ServiceType } from "@uo/shared";
import { Dialog } from "@/components/ui/overlays";
import { Button, CheckboxGroup, IssueList } from "@/components/ui/primitives";
import { type ApiError, api, qs } from "@/lib/api";

interface Result {
  created: number;
  customers: number;
  errors: { line: number; issues: string[] }[];
  warnings: { line: number; issues: string[] }[];
}

const lines = (rows: Result["errors"]) => rows.map((e) => `Line ${e.line}: ${e.issues.join("; ")}`);

/** Bulk lead import. Imported leads are unassigned and picked up by automatic assignment. */
export function ImportLeadsButton() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  // For files without a Service column (e.g. a list of businesses): one lead per business for each service.
  const [services, setServices] = useState<ServiceType[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: (f: File) => api.upload<Result>(`/opportunities/import${qs({ services: services.join(",") })}`, f),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ["opportunities"] });
    },
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <>
      <Button variant="secondary" onClick={() => (setOpen(true), setResult(null), setIssues([]))}>
        <FileUp /> Import CSV
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="Import leads from CSV" description="One lead per row. Leads arrive unassigned and are shared out automatically.">
        <div className="space-y-4 text-sm">
          <p>
            Columns (first row): <strong>Service</strong> (Electricity, Gas or Worldpay), or choose the services below. Optional: Name, Company or Business name, Contact or Owner / Manager name, Email, Phone, Campaign, Source, Notes, Expected revenue, Business Category (or Niche), Category, Industry, Address, Area, Opening hours.
          </p>
          <p className="text-muted">With an Address or Category, a customer is created for each business (a possible duplicate is listed instead, never merged), and energy leads get a supply site at the address.</p>
          <CheckboxGroup
            legend="Services for rows without a Service"
            hint="Each business gets one lead per service ticked."
            options={SELECTABLE_SERVICE_TYPES}
            labels={SERVICE_TYPE_LABELS}
            value={services}
            onChange={setServices}
            disabled={m.isPending}
          />
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" tabIndex={-1} onChange={(e) => e.target.files?.[0] && m.mutate(e.target.files[0])} aria-label="CSV file" />
          <Button loading={m.isPending} onClick={() => input.current?.click()}>
            <FileUp /> Choose CSV file
          </Button>
          {result && (
            <div role="status" className="rounded-lg bg-success-soft p-3 text-success">
              Imported {result.created} lead{result.created === 1 ? "" : "s"}
              {result.customers > 0 && ` and ${result.customers} customer${result.customers === 1 ? "" : "s"}`}.
            </div>
          )}
          {result && result.errors.length > 0 && <IssueList title={`${result.errors.length} row(s) skipped:`} issues={lines(result.errors)} />}
          {result && result.warnings.length > 0 && <IssueList title={`${result.warnings.length} business(es) may already be in the CRM:`} issues={lines(result.warnings)} />}
          <IssueList issues={issues} title="Couldn't import:" />
        </div>
      </Dialog>
    </>
  );
}
