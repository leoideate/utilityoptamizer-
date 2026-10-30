"use client";

import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/primitives";
import { api } from "./api";
import { cn } from "./format";

/**
 * The CRM phone panel: RingCentral Embeddable, a browser softphone (headset and mic), in an iframe on
 * RingCentral's own origin. Each salesperson signs in to it once with their RingCentral login. We load
 * its app page directly rather than its adapter script, so no third-party script runs in the CRM page;
 * the version is pinned, and the redirect page must match it (registered on the RingCentral app).
 */
export const EMBEDDABLE_ORIGIN = "https://apps.ringcentral.com";
export const EMBEDDABLE_BASE = `${EMBEDDABLE_ORIGIN}/integration/ringcentral-embeddable/3.0.0`;

export interface Telephony {
  provider: "manual" | "ringcentral";
  bridged: boolean;
  myPhone: string | null;
  browserPhone: { clientId: string; appServer: string; callerId: string | null } | null;
}

/** What the panel tells us about the call we asked it to dial. */
export type PanelCallEvent = "answered" | "ended";

interface PhoneContext {
  /** The panel is configured for this CRM. */
  available: boolean;
  /** Signed in to RingCentral and able to dial. */
  ready: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Dials from the panel; `onEvent` hears when that call is answered and when it ends. */
  dial: (number: string, onEvent: (e: PanelCallEvent) => void) => void;
}

const Ctx = createContext<PhoneContext>({ available: false, ready: false, open: false, setOpen: () => {}, dial: () => {} });
export const useBrowserPhone = () => useContext(Ctx);
export const useTelephony = () => useQuery({ queryKey: ["telephony"], queryFn: () => api.get<Telephony>("/telephony"), staleTime: 5 * 60_000 });

interface PanelCall {
  id?: string;
  telephonySessionId?: string;
  sessionId?: string;
  direction?: string;
}
const callKey = (c: PanelCall | undefined) => c?.telephonySessionId ?? c?.sessionId ?? c?.id ?? null;

function panelUrl(cfg: NonNullable<Telephony["browserPhone"]>) {
  const q = new URLSearchParams({
    clientId: cfg.clientId,
    appServer: cfg.appServer,
    redirectUri: `${EMBEDDABLE_BASE}/redirect.html`,
    defaultCallWith: "browser",
    // Calls only: texts, faxes, meetings and team messaging stay in RingCentral's own apps.
    disableMessages: "true",
    disableReadText: "true",
    disableMeeting: "true",
    disableGlip: "true",
    disableContacts: "true",
  });
  return `${EMBEDDABLE_BASE}/app.html?${q}`;
}

export function BrowserPhoneProvider({ children }: { children: ReactNode }) {
  const tel = useTelephony();
  const cfg = tel.data?.browserPhone ?? null;
  const frame = useRef<HTMLIFrameElement>(null);
  const [open, setOpen] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [dialer, setDialer] = useState(false);
  // The call the CRM asked for: claimed by the next outbound call the panel starts.
  const pending = useRef<((e: PanelCallEvent) => void) | null>(null);
  const tracked = useRef<{ key: string | null; onEvent: (e: PanelCallEvent) => void } | null>(null);

  useEffect(() => {
    if (!cfg) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== EMBEDDABLE_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const msg = e.data as { type?: string; loggedIn?: boolean; ready?: boolean; call?: PanelCall } | null;
      switch (msg?.type) {
        case "rc-login-status-notify":
          setLoggedIn(!!msg.loggedIn);
          break;
        case "rc-dialer-status-notify":
          setDialer(!!msg.ready);
          break;
        case "rc-call-ring-notify":
          // Incoming call: show the panel so it can be answered.
          setOpen(true);
          break;
        case "rc-call-init-notify":
          if (pending.current && msg.call?.direction !== "Inbound") {
            tracked.current = { key: callKey(msg.call), onEvent: pending.current };
            pending.current = null;
          }
          break;
        case "rc-call-start-notify":
        case "rc-call-end-notify": {
          const t = tracked.current;
          const key = callKey(msg.call);
          if (!t || (t.key && key && t.key !== key)) break;
          t.onEvent(msg.type === "rc-call-start-notify" ? "answered" : "ended");
          if (msg.type === "rc-call-end-notify") tracked.current = null;
          break;
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [cfg]);

  const dial = useCallback(
    (number: string, onEvent: (e: PanelCallEvent) => void) => {
      pending.current = onEvent;
      setOpen(true);
      frame.current?.contentWindow?.postMessage({ type: "rc-adapter-new-call", phoneNumber: number, toCall: true, ...(cfg?.callerId ? { callerId: cfg.callerId } : {}) }, EMBEDDABLE_ORIGIN);
    },
    [cfg],
  );

  const value = useMemo<PhoneContext>(() => ({ available: !!cfg, ready: !!cfg && loggedIn && dialer, open, setOpen, dial }), [cfg, loggedIn, dialer, open, dial]);
  const src = useMemo(() => (cfg ? panelUrl(cfg) : null), [cfg]);

  return (
    <Ctx.Provider value={value}>
      {children}
      {src && (
        // Kept mounted while hidden, so calls carry on and incoming calls still ring.
        <section
          aria-label="Phone"
          className={cn(
            "fixed bottom-4 right-4 z-40 flex w-[min(320px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[var(--md-sys-shape-corner-large)] bg-[var(--md-sys-color-surface-container-high)] shadow-lg",
            !open && "invisible pointer-events-none",
          )}
        >
          <div className="flex items-center justify-between px-3 py-1">
            <span className="text-sm font-medium">Phone</span>
            <Button variant="ghost" size="icon" aria-label="Hide phone" onClick={() => setOpen(false)}>
              <X />
            </Button>
          </div>
          <iframe ref={frame} title="RingCentral phone" src={src} allow="microphone; autoplay" className="h-[min(520px,calc(100dvh-7rem))] w-full border-0 bg-white" />
        </section>
      )}
    </Ctx.Provider>
  );
}
