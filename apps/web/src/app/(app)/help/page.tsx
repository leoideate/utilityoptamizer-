"use client";

import { ExternalLink } from "lucide-react";
import { Button, PageHeader } from "@/components/ui/primitives";

/** The team's guide to the CRM, served by the API to signed-in users only. */
export default function HelpPage() {
  return (
    <>
      <PageHeader
        title="Help & guide"
        description="How to take a deal from lead to Live / Won, and what every screen is for."
        actions={
          <Button asChild variant="secondary">
            <a href="/api/help/guide" target="_blank" rel="noreferrer">
              <ExternalLink /> Open in a new tab
            </a>
          </Button>
        }
      />
      <iframe src="/api/help/guide" title="CRM guide" className="h-[calc(100dvh-13rem)] min-h-[32rem] w-full rounded-[var(--md-sys-shape-corner-medium)] border border-border bg-surface" />
    </>
  );
}
