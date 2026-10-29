"use client";

import { useMutation } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { CustomerFields, type CustomerFormValues, emptyCustomer, toCustomerPayload } from "@/components/customer-form";
import { Button, Card, IssueList, PageHeader } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";

interface Duplicate {
  customer: { id: string; legalName: string; tradingName: string | null; email: string | null; phone: string | null; vatNumber: string | null; companyRegNumber: string | null };
  reasons: string[];
}

/** Creating a customer always checks for duplicates first. Nothing is ever merged automatically. */
export default function NewCustomerPage() {
  const router = useRouter();
  const form = useForm<CustomerFormValues>({ defaultValues: emptyCustomer });
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const create = useMutation({
    meta: { silent: true },
    mutationFn: ({ v, confirmNew }: { v: CustomerFormValues; confirmNew: boolean }) =>
      api.post<{ id?: string; duplicates?: Duplicate[] }>(`/customers${confirmNew ? "?confirmNew=true" : ""}`, toCustomerPayload(v)),
    onSuccess: (r) => {
      if (r.duplicates) setDuplicates(r.duplicates);
      else router.push(`/customers/${r.id}`);
    },
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New customer" description="We'll check for an existing record first." />
      <form onSubmit={form.handleSubmit((v) => (setIssues([]), create.mutate({ v, confirmNew: false })))} noValidate>
        <Card className="p-5">
          <CustomerFields form={form} />
        </Card>
        {duplicates && (
          <Card className="mt-4 border-warning/40 p-5" role="alert">
            <p className="flex items-center gap-2 font-semibold text-warning">
              <AlertTriangle className="size-5" aria-hidden /> This customer may already exist
            </p>
            <ul className="mt-3 divide-y divide-border">
              {duplicates.map((d) => (
                <li key={d.customer.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div>
                    <p className="font-medium">{d.customer.legalName}</p>
                    <p className="text-xs text-muted">{d.reasons.join(" · ")}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" asChild>
                      <Link href={`/customers/${d.customer.id}`}>Open existing</Link>
                    </Button>
                    <Button size="sm" asChild>
                      <Link href={`/opportunities/new?customerId=${d.customer.id}&company=${encodeURIComponent(d.customer.legalName)}`}>New lead for them</Link>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end">
              <Button variant="secondary" loading={create.isPending} onClick={form.handleSubmit((v) => create.mutate({ v, confirmNew: true }))}>
                It's a different business: create anyway
              </Button>
            </div>
          </Card>
        )}
        <div className="mt-4">
          <IssueList issues={issues} title="Please check:" />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => router.back()}>
            Cancel
          </Button>
          {!duplicates && (
            <Button type="submit" loading={create.isPending}>
              Check and create
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
