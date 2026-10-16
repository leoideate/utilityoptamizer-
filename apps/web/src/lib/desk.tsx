"use client";

import { type Desk, desksFor } from "@uo/shared";
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from "react";
import { useUser } from "./session";

interface DeskState {
  desk: Desk;
  desks: Desk[];
  setDesk: (d: Desk) => void;
}

const DeskContext = createContext<DeskState | null>(null);
const KEY = "uo-desk";

/** Which interface the user is working in. Managers and administrators can switch; the choice is remembered on this device. */
export function DeskProvider({ children }: { children: ReactNode }) {
  const user = useUser();
  const desks = useMemo(() => desksFor(user.roles), [user.roles]);
  const [desk, setState] = useState<Desk>(() => {
    try {
      const saved = localStorage.getItem(KEY) as Desk | null;
      if (saved && desks.includes(saved)) return saved;
    } catch {
      /* storage unavailable */
    }
    return desks[0];
  });
  const setDesk = useCallback(
    (d: Desk) => {
      if (!desks.includes(d)) return;
      setState(d);
      try {
        localStorage.setItem(KEY, d);
      } catch {
        /* storage unavailable */
      }
    },
    [desks],
  );
  const value = useMemo(() => ({ desk: desks.includes(desk) ? desk : desks[0], desks, setDesk }), [desk, desks, setDesk]);
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

export function useDesk(): DeskState {
  const d = useContext(DeskContext);
  if (!d) throw new Error("useDesk outside DeskProvider");
  return d;
}
