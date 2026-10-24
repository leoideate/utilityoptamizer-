import type { FormDocumentType, FormField } from "@uo/shared";
import { BGE_LAYOUT, bgeFields, bgeSignatureFields } from "./bord-gais-electricity/layout";
import { FLOGAS_ELECTRICITY_LAYOUT } from "./flogas-electricity/layout";
import { flogasLayoutFields } from "./flogas-electricity/render";

/** A supplier PDF filled by a dedicated application, recognised by its SHA-256 when uploaded. */
export interface WorkflowTemplate {
  workflow: string;
  name: string;
  supplier: string;
  documentType: FormDocumentType;
  sha256: readonly string[];
  pageCount: number;
  /** Every box, for the template record (the application decides which to fill). */
  fields: () => FormField[];
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    workflow: FLOGAS_ELECTRICITY_LAYOUT.workflow,
    name: FLOGAS_ELECTRICITY_LAYOUT.name,
    supplier: FLOGAS_ELECTRICITY_LAYOUT.supplier,
    documentType: FLOGAS_ELECTRICITY_LAYOUT.documentType,
    sha256: FLOGAS_ELECTRICITY_LAYOUT.sha256,
    pageCount: FLOGAS_ELECTRICITY_LAYOUT.pages.length,
    fields: flogasLayoutFields,
  },
  {
    workflow: BGE_LAYOUT.workflow,
    name: BGE_LAYOUT.name,
    supplier: BGE_LAYOUT.supplier,
    documentType: BGE_LAYOUT.documentType,
    sha256: BGE_LAYOUT.sha256,
    pageCount: BGE_LAYOUT.pages.length,
    fields: () => [...bgeFields(), ...bgeSignatureFields(["customer", "account_holder_2"], true)],
  },
];

export const workflowTemplateFor = (sha256: string) => WORKFLOW_TEMPLATES.find((t) => t.sha256.includes(sha256));
