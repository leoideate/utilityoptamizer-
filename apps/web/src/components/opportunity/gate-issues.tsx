"use client";

import { gateIssueArea } from "@uo/shared";
import { ArrowRight } from "lucide-react";

/** What the opportunity shows, to pick the tab an issue is fixed on. */
export interface GateTabs {
  energy: boolean;
  flogas: boolean;
  bordGais: boolean;
}

/**
 * The opportunity tab where a "can't move yet" issue is fixed (see gateIssueArea), or "approve" for
 * internal approval, which is the Approval dialog. Supplier forms open their own tab when it's there.
 */
export function gateIssueTarget(issue: string, t: GateTabs): string {
  const { area, form } = gateIssueArea(issue);
  const supplierTab = t.flogas ? "flogas" : t.bordGais ? "bord-gais" : null;
  switch (area) {
    case "approval":
      return "approve";
    case "details":
      return "overview";
    case "supply":
      return t.energy ? "energy" : "worldpay";
    case "worldpay":
      return "worldpay";
    case "documents":
      return "documents";
    case "signatures":
      return supplierTab ?? "signatures";
    case "form":
      // Supplier application forms are named after the supplier ("Flogas electricity: …").
      if (t.flogas && form && /^flogas/i.test(form)) return "flogas";
      if (t.bordGais && form && /^bo(a)?rd g[aá]is/i.test(form)) return "bord-gais";
      return "forms";
    default:
      return "forms";
  }
}

/** The issues blocking a stage move, each a link to where it's fixed. */
export function GateIssueList({ issues, tabs, onGo, title = "This opportunity still needs:" }: { issues: string[]; tabs: GateTabs; onGo: (target: string) => void; title?: string }) {
  if (!issues.length) return null;
  return (
    <div role="alert" className="rounded-[var(--md-sys-shape-corner-small)] bg-warning-soft p-3 text-sm text-[var(--md-sys-color-on-warning-container)]">
      <p className="font-medium">{title}</p>
      <ul className="mt-1 space-y-1">
        {issues.map((issue) => (
          <li key={issue}>
            <button type="button" onClick={() => onGo(gateIssueTarget(issue, tabs))} className="inline-flex min-h-6 items-start gap-1.5 text-left underline-offset-2 hover:underline focus-visible:underline">
              <ArrowRight className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{issue}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
