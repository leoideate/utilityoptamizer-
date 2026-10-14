"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { Dialog } from "@/components/ui/overlays";
import { Button, IssueList } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";

interface Result {
  created: number;
  errors: { line: number; issues: string[] }[];
}

/** Bulk lead import. Imported leads are unassigned and picked up by automatic assignment. */
export function ImportLeadsButton() {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const m = useMutation({
    meta: { silent: true },
    mutationFn: (f: File) => api.upload<Result>("/opportunities/import", f),
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
            Columns (first row): <strong>Service</strong> (Electricity, Gas, Dual fuel or Worldpay) is required. Optional: Name, Company, Contact, Email, Phone, Campaign, Source, Notes, Expected revenue.
          </p>
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" tabIndex={-1} onChange={(e) => e.target.files?.[0] && m.mutate(e.target.files[0])} aria-label="CSV file" />
          <Button loading={m.isPending} onClick={() => input.current?.click()}>
            <FileUp /> Choose CSV file
          </Button>
          {result && (
            <div role="status" className="rounded-lg bg-success-soft p-3 text-success">
              Imported {result.created} lead{result.created === 1 ? "" : "s"}.
            </div>
          )}
          {result && result.errors.length > 0 && <IssueList title={`${result.errors.length} row(s) skipped:`} issues={result.errors.map((e) => `Line ${e.line}: ${e.issues.join("; ")}`)} />}
          <IssueList issues={issues} title="Couldn't import:" />
        </div>
      </Dialog>
    </>
  );
}
