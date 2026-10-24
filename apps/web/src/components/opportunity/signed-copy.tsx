"use client";

import { useMutation } from "@tanstack/react-query";
import { FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { Button, IssueList } from "@/components/ui/primitives";
import { type ApiError, api } from "@/lib/api";
import { dateTime } from "@/lib/format";

/** A signed copy uploaded as a scan of the paper form (see FormsService.uploadSignedCopy). */
export interface SignedCopyUpload {
  uploadedById: string | null;
  uploadedBy: string | null;
  uploadedAt: string;
}

/**
 * Uploads the form as the customer signed it on paper (a scanned PDF). It replaces any signed copy
 * and goes for review, where someone other than the uploader checks it.
 */
export function SignedCopyButton({ formId, replacing, onUploaded }: { formId: string; replacing: boolean; onUploaded: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const upload = useMutation({
    meta: { silent: true },
    mutationFn: (file: File) => api.upload(`/forms/${formId}/signed-copy`, file),
    onSuccess: () => (setIssues([]), onUploaded()),
    onError: (e) => setIssues((e as ApiError).issues?.length ? (e as ApiError).issues : [(e as ApiError).message]),
  });
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".pdf,application/pdf"
        className="sr-only"
        tabIndex={-1}
        aria-label="Upload the signed PDF"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) upload.mutate(file);
        }}
      />
      <Button size="sm" variant="ghost" loading={upload.isPending} onClick={() => input.current?.click()} title="The customer signed the printed form: upload the scan for review">
        <FileUp /> {replacing ? "Upload a new signed PDF" : "Upload signed PDF"}
      </Button>
      {!!issues.length && (
        <div className="basis-full">
          <IssueList issues={issues} title="The signed PDF wasn't uploaded:" />
        </div>
      )}
    </>
  );
}

/** "Signed on paper, uploaded by …" under a form whose signed copy is a scan. */
export function SignedCopyNote({ upload }: { upload: SignedCopyUpload | null }) {
  if (!upload) return null;
  return (
    <p className="text-xs text-muted">
      Signed on paper: signed PDF uploaded by {upload.uploadedBy ?? "system"} {dateTime(upload.uploadedAt)}. Someone else reviews it.
    </p>
  );
}
