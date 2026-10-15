"use client";

import { useQuery } from "@tanstack/react-query";
import { Flame, Plug, Zap, CreditCard } from "lucide-react";
import { SERVICE_TYPE_LABELS, type ServiceType } from "@uo/shared";
import { api } from "@/lib/api";
import { Badge, Select } from "./ui/primitives";

export interface UserLite {
  id: string;
  name: string;
  roles: { role: string }[];
}
export interface Supplier {
  id: string;
  name: string;
  kind: "energy" | "merchant";
  active: boolean;
  submissionEmail: string | null;
}

export const useAssignableUsers = () => useQuery({ queryKey: ["users", "assignable"], queryFn: () => api.get<UserLite[]>("/users/assignable"), staleTime: 5 * 60_000 });
export const useSuppliers = (kind?: "energy" | "merchant") =>
  useQuery({ queryKey: ["suppliers", kind], queryFn: () => api.get<Supplier[]>(`/suppliers${kind ? `?kind=${kind}` : ""}`), staleTime: 5 * 60_000 });

const SERVICE_ICONS: Record<ServiceType, typeof Zap> = { electricity: Zap, gas: Flame, dual_fuel: Plug, merchant_services: CreditCard };

export function ServiceBadge({ service, short }: { service: ServiceType; short?: boolean }) {
  const Icon = SERVICE_ICONS[service];
  const tone = service === "merchant_services" ? "info" : service === "gas" ? "accent" : "primary";
  return (
    <Badge tone={tone}>
      <Icon className="size-3" aria-hidden />
      {short && service === "merchant_services" ? "Worldpay" : SERVICE_TYPE_LABELS[service]}
    </Badge>
  );
}

export function OutcomeBadge({ outcome }: { outcome: "open" | "won" | "lost" }) {
  if (outcome === "won") return <Badge tone="success">Live / Won</Badge>;
  if (outcome === "lost") return <Badge tone="danger">Lost</Badge>;
  return <Badge tone="neutral">Open</Badge>;
}

export function UserSelect({ value, onChange, includeUnassigned, label = "Salesperson", ...rest }: { value: string; onChange: (v: string) => void; includeUnassigned?: boolean; label?: string; id?: string }) {
  const users = useAssignableUsers();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} {...rest}>
      <option value="">{includeUnassigned ? "Unassigned" : "Anyone"}</option>
      {users.data?.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </Select>
  );
}

/** Horizontal bar list: readable, accessible and works at any width. */
export function BarList({ rows, format = (n: number) => String(n), empty = "No data for this period." }: { rows: { label: string; value: number; hint?: string; href?: string }[]; format?: (n: number) => string; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length || rows.every((r) => r.value === 0)) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0 truncate">{r.href ? <a className="inline-block py-0.5 hover:underline" href={r.href}>{r.label}</a> : r.label}</span>
            <span className="tabular shrink-0 font-medium">
              {format(r.value)}
              {r.hint && <span className="ml-1 text-xs font-normal text-muted">{r.hint}</span>}
            </span>
          </div>
          <div className="h-2 rounded-full bg-surface-2" aria-hidden>
            <div className="h-2 rounded-full bg-primary" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
