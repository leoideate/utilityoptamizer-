"use client";

import { useQueryClient } from "@tanstack/react-query";

/** Refreshes everything shown in an opportunity workspace after a change. */
export function useRefreshOpportunity(id: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["opportunity", id] });
    qc.invalidateQueries({ queryKey: ["opportunities"] });
    qc.invalidateQueries({ queryKey: ["board"] });
  };
}

/** Converts form strings to API values: "" → null, numeric strings → numbers. */
export function numOrNull(v: string | number | null | undefined): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export const blankToNull = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() ? v.trim() : null);
