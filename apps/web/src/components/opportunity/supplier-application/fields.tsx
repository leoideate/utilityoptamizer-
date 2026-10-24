"use client";

import { type ReactNode, useEffect, useState } from "react";
import type { ApplicationAddress } from "@uo/shared";
import { Card, CardHeader, Field, Input, IssueList, Select } from "@/components/ui/primitives";

/** Field controls shared by the supplier application forms (Flogas, Bord Gáis). */

export const orNull = (v: string) => (v.trim() === "" ? null : v);

export function Text({ label, value, onChange, error, required, hint, type = "text", inputMode, maxLength = 200, disabled, autoComplete }: { label: string; value: string | null; onChange: (v: string | null) => void; error?: string; required?: boolean; hint?: string; type?: string; inputMode?: "text" | "email" | "tel" | "numeric" | "decimal"; maxLength?: number; disabled?: boolean; autoComplete?: string }) {
  return (
    <Field label={label} error={error} required={required} hint={hint}>
      {(p) => <Input {...p} type={type} inputMode={inputMode} maxLength={maxLength} disabled={disabled} autoComplete={autoComplete ?? "off"} value={value ?? ""} onChange={(e) => onChange(orNull(e.target.value))} />}
    </Field>
  );
}

/**
 * A non-negative number (whole when `step` is "1"); anything else typed is ignored, and the server
 * checks again. What's typed is kept as text, so "1.0" on the way to "1.05" isn't turned into 1 (a
 * number field re-rendered from the parsed value drops the trailing ".0").
 */
export function Num({ label, value, onChange, error, required, hint, step = "0.01", disabled }: { label: string; value: number | null; onChange: (v: number | null) => void; error?: string; required?: boolean; hint?: string; step?: string; disabled?: boolean }) {
  const whole = step === "1";
  const [text, setText] = useState(value == null ? "" : String(value));
  // Follow changes made elsewhere (a reset or reload), but not the echo of what's being typed.
  useEffect(() => {
    setText((t) => (parseNum(t) === value ? t : value == null ? "" : String(value)));
  }, [value]);
  return (
    <Field label={label} error={error} required={required} hint={hint}>
      {(p) => (
        <Input
          {...p}
          type="text"
          inputMode={whole ? "numeric" : "decimal"}
          autoComplete="off"
          disabled={disabled}
          value={text}
          onChange={(e) => {
            const t = e.target.value.replace(",", ".").trim();
            if (!(whole ? /^\d*$/ : /^\d*\.?\d*$/).test(t)) return;
            setText(t);
            const n = parseNum(t);
            if (n !== undefined) onChange(n);
          }}
        />
      )}
    </Field>
  );
}

/** null for blank, undefined while it isn't a number yet ("."). */
function parseNum(t: string): number | null | undefined {
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && t !== "." ? n : undefined;
}

export function YesNo({ label, value, onChange, error, required, hint, disabled }: { label: string; value: boolean | null; onChange: (v: boolean | null) => void; error?: string; required?: boolean; hint?: string; disabled?: boolean }) {
  return (
    <Field label={label} error={error} required={required} hint={hint}>
      {(p) => (
        <Select {...p} disabled={disabled} value={value === null ? "" : value ? "yes" : "no"} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "yes")}>
          <option value="">Not answered</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      )}
    </Field>
  );
}

export function AddressFields({ legend, value, onChange, error, required, disabled }: { legend: string; value: ApplicationAddress; onChange: (a: ApplicationAddress) => void; error?: string; required?: boolean; disabled?: boolean }) {
  const line = (k: keyof ApplicationAddress, label: string, req = false, max = 200) => <Text label={label} required={req} maxLength={max} disabled={disabled} value={value[k]} onChange={(v) => onChange({ ...value, [k]: v })} />;
  return (
    <fieldset className="space-y-3 sm:col-span-2">
      <legend className="mb-2 text-sm font-medium">
        {legend}
        {required && <span className="text-danger"> *</span>}
      </legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {line("line1", "Address line 1", required)}
        {line("line2", "Address line 2")}
        {line("city", "Town / city", false, 100)}
        {line("county", "County", false, 100)}
        {line("postcode", "Eircode", false, 20)}
      </div>
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}

export function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <div className="grid gap-4 p-5 sm:grid-cols-2">{children}</div>
    </Card>
  );
}

export function TabSummary({ issues }: { issues: { message: string }[] }) {
  return issues.length ? <IssueList issues={issues.map((i) => i.message)} title={`${issues.length} thing${issues.length === 1 ? "" : "s"} to complete on this tab:`} /> : null;
}
