"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { LEAD_SOURCES, LEAD_SOURCE_LABELS, SALE_TYPES, SALE_TYPE_LABELS, SERVICE_TYPES, SERVICE_TYPE_LABELS } from "@uo/shared";
import { UserSelect } from "@/components/domain";
import { Button, Card, Field, Input, PageHeader, Select } from "@/components/ui/primitives";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";

/** Quick capture: only a name and service are required. Everything else can come later. */
const schema = z.object({
  name: z.string().trim().min(1, "Give the opportunity a name, e.g. the business and service."),
  serviceType: z.enum(SERVICE_TYPES),
  saleType: z.enum(SALE_TYPES),
  companyName: z.string().optional(),
  contactName: z.string().optional(),
  email: z.union([z.literal(""), z.string().trim().email("Enter a valid email address.")]).optional(),
  phone: z.string().optional(),
  leadSource: z.enum(LEAD_SOURCES),
  leadSourceDetail: z.string().optional(),
  campaign: z.string().optional(),
  expectedRevenue: z.union([z.literal(""), z.coerce.number().min(0, "Can't be negative.")]).optional(),
  nextAction: z.string().optional(),
  followUpDate: z.string().optional(),
  ownerId: z.string().optional(),
  customerId: z.string().optional(),
});
type Values = z.infer<typeof schema>;

function NewOpportunityForm() {
  const router = useRouter();
  const params = useSearchParams();
  const can = useCan();
  const { register, handleSubmit, formState, setValue, watch } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { serviceType: "electricity", saleType: "new_sale", leadSource: "telephone", customerId: params.get("customerId") ?? undefined, companyName: params.get("company") ?? "" },
  });
  const create = useMutation({
    mutationFn: (v: Values) =>
      api.post<{ id: string }>("/opportunities", {
        ...v,
        expectedRevenue: v.expectedRevenue === "" || v.expectedRevenue === undefined ? null : v.expectedRevenue,
        followUpDate: v.followUpDate || null,
        ownerId: can("opportunity.assign") ? v.ownerId || null : undefined,
        customerId: v.customerId || null,
      }),
    onSuccess: (r) => router.push(`/opportunities/${r.id}`),
  });
  const e = formState.errors;

  return (
    <form onSubmit={handleSubmit((v) => create.mutate(v))} noValidate className="space-y-6">
      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">The deal</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Opportunity name" required error={e.name?.message} className="sm:col-span-2">
            {(p) => <Input {...p} placeholder="e.g. Harbour Café – electricity" autoFocus {...register("name")} />}
          </Field>
          <Field label="Service">
            {(p) => (
              <Select {...p} {...register("serviceType")}>
                {SERVICE_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_TYPE_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Sale type">
            {(p) => (
              <Select {...p} {...register("saleType")}>
                {SALE_TYPES.map((s) => (
                  <option key={s} value={s}>
                    {SALE_TYPE_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Lead source">
            {(p) => (
              <Select {...p} {...register("leadSource")}>
                {LEAD_SOURCES.filter((s) => s !== "renewal").map((s) => (
                  <option key={s} value={s}>
                    {LEAD_SOURCE_LABELS[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Campaign" hint="Optional">
            {(p) => <Input {...p} {...register("campaign")} />}
          </Field>
          <Field label="Source details" hint="Who referred them, which web form, etc." className="sm:col-span-2">
            {(p) => <Input {...p} {...register("leadSourceDetail")} />}
          </Field>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Who is it?</h2>
          <p className="text-sm text-muted">Just capture what you know. You can create or link the full customer record later.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name">{(p) => <Input {...p} autoComplete="organization" {...register("companyName")} />}</Field>
          <Field label="Contact name">{(p) => <Input {...p} autoComplete="name" {...register("contactName")} />}</Field>
          <Field label="Email" error={e.email?.message}>
            {(p) => <Input {...p} type="email" autoComplete="email" {...register("email")} />}
          </Field>
          <Field label="Phone">{(p) => <Input {...p} type="tel" autoComplete="tel" {...register("phone")} />}</Field>
        </div>
      </Card>

      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">Next steps</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Next action">{(p) => <Input {...p} placeholder="e.g. Call to get latest bill" {...register("nextAction")} />}</Field>
          <Field label="Follow-up date" hint="A first-contact task is created for this date (today if blank).">
            {(p) => <Input {...p} type="date" {...register("followUpDate")} />}
          </Field>
          <Field label="Expected revenue (€)" error={e.expectedRevenue?.message}>
            {(p) => <Input {...p} inputMode="decimal" {...register("expectedRevenue")} />}
          </Field>
          {can("opportunity.assign") && (
            <Field label="Salesperson" hint="Leave unassigned to let the system assign it.">
              {(p) => <UserSelect {...p} value={watch("ownerId") ?? ""} onChange={(v) => setValue("ownerId", v)} includeUnassigned />}
            </Field>
          )}
        </div>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => router.back()}>
          Cancel
        </Button>
        <Button type="submit" loading={create.isPending}>
          Create opportunity
        </Button>
      </div>
    </form>
  );
}

export default function NewOpportunityPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New opportunity" description="Only the name and service are required." />
      <Suspense>
        <NewOpportunityForm />
      </Suspense>
    </div>
  );
}
