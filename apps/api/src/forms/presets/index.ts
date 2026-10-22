import { BORD_GAIS_GAS_CAF } from "./bord-gais-gas";
import type { FormPreset } from "./builder";
import { ENERGIA_CUSTOMER_REGISTRATION } from "./energia";
import { FLOGAS_ELECTRICITY_AGREEMENT } from "./flogas-electricity";
import { FLOGAS_GAS_SME_AGREEMENT } from "./flogas-gas";

export type { FormPreset } from "./builder";

/**
 * Supplier forms that come set up. The PDFs themselves aren't in the repository (they belong to the
 * suppliers); uploading one whose SHA-256 matches creates its template with every field placed.
 */
export const FORM_PRESETS: FormPreset[] = [FLOGAS_GAS_SME_AGREEMENT, FLOGAS_ELECTRICITY_AGREEMENT, BORD_GAIS_GAS_CAF, ENERGIA_CUSTOMER_REGISTRATION];

export const presetFor = (sha256: string): FormPreset | undefined => FORM_PRESETS.find((p) => p.sha256 === sha256);
