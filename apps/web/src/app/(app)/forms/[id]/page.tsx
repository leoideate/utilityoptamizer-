"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TemplateEditor } from "@/components/forms/template-editor";
import { EmptyState, PageHeader } from "@/components/ui/primitives";
import { useCan } from "@/lib/session";

export default function FormTemplatePage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  if (!can("form.template_manage")) return <EmptyState title="Supplier forms are managed by administrators, managers and operations." />;
  return (
    <>
      <Link href="/forms" className="mb-2 inline-flex min-h-6 items-center gap-1 text-sm text-muted hover:underline">
        <ArrowLeft className="size-4" aria-hidden /> Supplier forms
      </Link>
      <PageHeader title="Edit form template" description="Each box is written onto the PDF when a form is filled. Changing the boxes makes a new template version; forms already filled keep theirs." />
      <TemplateEditor id={id} />
    </>
  );
}
