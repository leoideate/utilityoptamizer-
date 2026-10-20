"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { BUCKETS, type Bucket, CasesBoard } from "@/components/cases-board";

function Cases() {
  const params = useSearchParams();
  const bucket = BUCKETS.find((b) => b.key === params.get("bucket"))?.key as Bucket | undefined;
  return (
    <CasesBoard
      title="Cases"
      description="Renewals, changes of entity and changes of supplier, from the request to the external party's acceptance. The work queue holds the deals handed over at Supplier selected."
      initialScope={params.get("scope") === "back_office" ? "back_office" : undefined}
      initialBucket={bucket}
    />
  );
}

export default function CasesPage() {
  return (
    <Suspense>
      <Cases />
    </Suspense>
  );
}
