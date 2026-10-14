"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Camera, ImageUp, Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { SERVICE_TYPES, SERVICE_TYPE_LABELS, type ServiceType } from "@uo/shared";
import { Badge, Button, Card, CardHeader, Field, Input, IssueList, PageHeader, Select } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { cn } from "@/lib/format";

type Fields = { firstName: string; lastName: string; company: string; jobTitle: string; email: string; phone: string; mobile: string; website: string; address: string };
const EMPTY: Fields = { firstName: "", lastName: "", company: "", jobTitle: "", email: "", phone: "", mobile: "", website: "", address: "" };
const LABELS: Record<keyof Fields, string> = { firstName: "First name", lastName: "Last name", company: "Company", jobTitle: "Job title", email: "Email", phone: "Telephone", mobile: "Mobile", website: "Website", address: "Address" };

interface Scan {
  id: string;
  status: "uploaded" | "processing" | "processed" | "failed" | "confirmed" | "discarded";
  confidence: number | null;
  parsed: Partial<Record<keyof Fields, string | null>> | null;
  error: string | null;
  imageUrl: string;
  automatic: boolean;
  duplicates: Duplicate[];
}
interface Duplicate {
  customer: { id: string; legalName: string; email: string | null; phone: string | null };
  reasons: string[];
}

/** Upload → OCR → review & correct → duplicate check → confirm. Nothing is created until confirmed. */
export default function ScanPage() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [service, setService] = useState<ServiceType>("electricity");
  const [linkTo, setLinkTo] = useState<string>("");
  const [issues, setIssues] = useState<string[]>([]);
  const [over, setOver] = useState(false);

  const upload = useMutation({
    meta: { silent: true },
    mutationFn: (f: File) => api.upload<{ id: string }>("/business-cards", f),
    onSuccess: (r) => setScanId(r.id),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  const scan = useQuery({ queryKey: ["scan", scanId], queryFn: () => api.get<Scan>(`/business-cards/${scanId}`), enabled: !!scanId });
  useEffect(() => {
    if (scan.data?.parsed) setFields({ ...EMPTY, ...Object.fromEntries(Object.entries(scan.data.parsed).map(([k, v]) => [k, v ?? ""])) });
  }, [scan.data?.parsed]);

  const dupes = useQuery({
    queryKey: ["scan", scanId, "dupes", fields.email, fields.phone, fields.mobile, fields.company],
    queryFn: () => api.post<Duplicate[]>(`/business-cards/${scanId}/duplicates`, { email: fields.email || null, phone: fields.phone || null, mobile: fields.mobile || null, company: fields.company || null }),
    enabled: !!scanId && !!scan.data,
  });

  const confirm = useMutation({
    meta: { silent: true },
    mutationFn: () =>
      api.post<{ opportunityId: string }>(`/business-cards/${scanId}/confirm`, {
        ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.trim() || null])),
        existingCustomerId: linkTo || null,
        serviceType: service,
      }),
    onSuccess: (r) => router.push(`/opportunities/${r.opportunityId}`),
    onError: (e) => setIssues((e as ApiError).issues.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  const discard = useMutation({ mutationFn: () => api.post(`/business-cards/${scanId}/discard`), onSuccess: () => reset() });
  const reset = () => {
    setScanId(null);
    setFields(EMPTY);
    setLinkTo("");
    setIssues([]);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) upload.mutate(f);
  };

  if (!scanId) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Scan business card" description="Take a photo or upload one. You'll check the details before anything is saved." />
        <Card
          className={cn("flex flex-col items-center gap-4 border-2 border-dashed p-10 text-center", over && "border-primary bg-primary-soft")}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          {upload.isPending ? <Loader2 className="size-10 animate-spin text-primary" aria-label="Reading card" /> : <ImageUp className="size-10 text-muted" aria-hidden />}
          <p className="text-sm text-muted">Drop a photo here, or</p>
          <div className="flex flex-wrap justify-center gap-2">
            <input ref={input} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} aria-label="Card photo" />
            <Button onClick={() => input.current?.click()} loading={upload.isPending}>
              <Camera /> Take or choose a photo
            </Button>
          </div>
          <IssueList issues={issues} title="Couldn't use that file:" />
        </Card>
      </div>
    );
  }

  const s = scan.data;
  return (
    <>
      <PageHeader
        title="Check the details"
        description="Correct anything the scan got wrong. Nothing is created until you confirm."
        actions={
          <Button variant="secondary" onClick={() => discard.mutate()}>
            <RotateCcw /> Start again
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_1fr]">
        <Card className="p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {s && <img src={s.imageUrl} alt="Uploaded business card" className="w-full rounded-lg" />}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {s?.status === "failed" && <Badge tone="warning">{s.error}</Badge>}
            {s && !s.automatic && <Badge>Automatic reading is off: type the details while looking at the card</Badge>}
            {s?.confidence != null && <Badge tone={s.confidence > 0.8 ? "success" : "warning"}>Scan confidence {Math.round(s.confidence * 100)}%</Badge>}
          </div>
        </Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Contact & company" />
            <div className="grid gap-4 p-5 sm:grid-cols-2">
              {(Object.keys(EMPTY) as (keyof Fields)[]).map((k) => (
                <Field key={k} label={LABELS[k]} className={k === "address" || k === "company" ? "sm:col-span-2" : undefined}>
                  {(p) => <Input {...p} type={k === "email" ? "email" : k === "phone" || k === "mobile" ? "tel" : "text"} value={fields[k]} onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))} />}
                </Field>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title="Existing customers" description="Link to an existing customer if this is one of them." />
            <div className="space-y-2 p-5 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="link" checked={!linkTo} onChange={() => setLinkTo("")} className="accent-[var(--primary)]" /> Create a new customer
              </label>
              {dupes.data?.map((d) => (
                <label key={d.customer.id} className="flex items-center gap-2">
                  <input type="radio" name="link" checked={linkTo === d.customer.id} onChange={() => setLinkTo(d.customer.id)} className="accent-[var(--primary)]" />
                  Link to <strong>{d.customer.legalName}</strong> <span className="text-xs text-muted">({d.reasons.join(", ").toLowerCase()})</span>
                </label>
              ))}
              {dupes.data && !dupes.data.length && <p className="text-muted">No matching customers found.</p>}
            </div>
          </Card>
          <Card className="flex flex-wrap items-end gap-4 p-5">
            <Field label="Opportunity for" className="min-w-56 flex-1">
              {(p) => (
                <Select {...p} value={service} onChange={(e) => setService(e.target.value as ServiceType)}>
                  {SERVICE_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {SERVICE_TYPE_LABELS[x]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button loading={confirm.isPending} onClick={() => (setIssues([]), confirm.mutate())}>
              Confirm and create opportunity
            </Button>
          </Card>
          <IssueList issues={issues} title="Please check:" />
        </div>
      </div>
    </>
  );
}
