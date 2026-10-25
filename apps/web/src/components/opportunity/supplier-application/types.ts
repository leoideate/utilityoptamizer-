import type { ApplicationStatus, FormSignerRole, FormStatus, SignatureAuthorisation, SigningLinkStatus } from "@uo/shared";
import type { SignedCopyUpload } from "../signed-copy";

/** One generated version of a supplier application, as the API describes it. */
export interface ApplicationVersion {
  version: number;
  formId: string;
  layoutVersion: string;
  templateVersion: number;
  createdAt: string;
  createdBy: string | null;
  status: FormStatus;
  current: boolean;
  qcPassed: boolean;
  versionId: string;
  signedVersionId: string | null;
  /** The signed copy is a scan of the form signed on paper. */
  signedCopyUpload: SignedCopyUpload | null;
  sensitive: boolean;
  requiredSigners: FormSignerRole[];
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  signatures: { id: string; role: FormSignerRole; signerName: string; authorisation: SignatureAuthorisation; uploadedAt: string; uploadedById: string | null; online: boolean }[];
  links: {
    id: string;
    role: FormSignerRole;
    signerName: string;
    signerEmail: string;
    status: SigningLinkStatus;
    sentAt: string;
    openedAt: string | null;
    signedAt: string | null;
    declinedAt: string | null;
    declineReason: string | null;
    expiresAt: string;
    sentById: string | null;
  }[];
}

/** What every supplier application's API returns besides its own data and issues. */
export interface ApplicationViewBase {
  applies: boolean;
  needsCustomer: boolean;
  template: { id: string; name: string; version: number } | null;
  layoutVersion: string;
  answered: string[];
  signers: FormSignerRole[];
  status: ApplicationStatus;
  stale: boolean;
  currentFormId: string | null;
  contract: { id: string; readOnly: boolean } | null;
  versions: ApplicationVersion[];
  issues: { path: string; message: string }[];
  permissions: { write: boolean; customerWrite: boolean; bankRead: boolean; bankWrite: boolean; readSensitive: boolean; review: boolean };
}

/** New bank details typed on a Direct Debit tab (saved ones never reach the browser without bank.read). */
export interface BankEdit {
  accountName: string;
  iban: string;
  bic: string;
}
