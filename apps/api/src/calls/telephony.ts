import type { CallStatus } from "@prisma/client";

/** What a provider reports about a call in progress. */
export interface ProviderCallState {
  status: CallStatus;
  /** Plain-language detail for the user, e.g. "Your phone wasn't answered". */
  detail?: string;
}

/**
 * Click-to-call provider. "Bridged" providers ring the salesperson's own phone first, then
 * connect the customer, so calls work from any desk phone or mobile without a softphone.
 */
export interface TelephonyProvider {
  readonly name: "manual" | "ringcentral";
  readonly bridged: boolean;
  start(input: { agentNumber: string; customerNumber: string }): Promise<{ providerCallId: string }>;
  status(providerCallId: string): Promise<ProviderCallState>;
  cancel(providerCallId: string): Promise<void>;
}

export const TELEPHONY_PROVIDER = Symbol("TELEPHONY_PROVIDER");

export const FINAL_STATUSES: CallStatus[] = ["completed", "no_answer", "busy", "failed", "canceled"];

/** No telephony account: the browser opens the phone's dialler and the user records the outcome. */
export class ManualTelephony implements TelephonyProvider {
  readonly name = "manual" as const;
  readonly bridged = false;
  async start(): Promise<{ providerCallId: string }> {
    throw new Error("Manual calls are placed from the user's own phone.");
  }
  async status(): Promise<ProviderCallState> {
    return { status: "initiated" };
  }
  async cancel() {
    /* nothing to cancel */
  }
}

export interface RingOutStatus {
  callStatus?: string;
  callerStatus?: string;
  calleeStatus?: string;
}

/**
 * Maps a RingCentral RingOut status to our call status. The caller is our salesperson's phone
 * (rung first); the callee is the customer.
 */
export function mapRingOut(s: RingOutStatus): ProviderCallState {
  const caller = s.callerStatus ?? "InProgress";
  const callee = s.calleeStatus ?? "InProgress";
  if (s.callStatus === "CannotReach") return { status: "failed", detail: "The call couldn't be connected." };
  if (s.callStatus === "NoAnsweringMachine") return { status: "no_answer", detail: "The customer didn't answer." };
  if (["Busy", "NoAnswer", "Rejected"].includes(caller)) return { status: "canceled", detail: "Your phone wasn't answered, so the customer wasn't called." };
  if (["GenericError", "Invalid", "InternationalDisabled", "NoSessionFound"].includes(caller)) return { status: "failed", detail: `Your phone couldn't be reached (${caller}).` };
  if (caller === "InProgress") return { status: "ringing_agent" };
  // Our side answered: now it depends on the customer.
  switch (callee) {
    case "InProgress":
      return { status: "ringing_customer" };
    case "Success":
      return { status: "in_progress" };
    case "Finished":
      return { status: "completed" };
    case "Busy":
      return { status: "busy", detail: "The customer's line was busy." };
    case "NoAnswer":
    case "Rejected":
      return { status: "no_answer", detail: "The customer didn't answer." };
    case "NoSessionFound":
      return { status: "completed" };
    default:
      return { status: "failed", detail: `The call couldn't be connected (${callee}).` };
  }
}

export interface RingCentralConfig {
  serverUrl: string;
  clientId: string;
  clientSecret: string;
  jwt: string;
  callerId?: string;
  playPrompt: boolean;
}

/**
 * RingCentral RingOut (POST /restapi/v1.0/account/~/extension/~/ring-out). The app authenticates
 * as one RingCentral user with a JWT credential (needs the "RingOut" app permission); `from` is the
 * salesperson's phone, `to` the customer, `callerId` the company number customers see.
 */
export class RingCentralTelephony implements TelephonyProvider {
  readonly name = "ringcentral" as const;
  readonly bridged = true;
  private token: { value: string; expires: number } | null = null;

  constructor(private readonly cfg: RingCentralConfig) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.cfg.serverUrl}/restapi/oauth/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: this.cfg.jwt }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`RingCentral sign-in failed (HTTP ${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T | null }> {
    const send = async () =>
      fetch(`${this.cfg.serverUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    let res = await send();
    if (res.status === 401) {
      this.token = null;
      res = await send();
    }
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as T) : null };
  }

  async start(input: { agentNumber: string; customerNumber: string }) {
    const { status, body } = await this.call<{ id: string | number; message?: string }>("POST", "/restapi/v1.0/account/~/extension/~/ring-out", {
      from: { phoneNumber: input.agentNumber },
      to: { phoneNumber: input.customerNumber },
      ...(this.cfg.callerId ? { callerId: { phoneNumber: this.cfg.callerId } } : {}),
      playPrompt: this.cfg.playPrompt,
    });
    if (status >= 300 || !body?.id) throw new Error(`RingCentral couldn't start the call (HTTP ${status}${body?.message ? `: ${body.message}` : ""})`);
    return { providerCallId: String(body.id) };
  }

  async status(id: string): Promise<ProviderCallState> {
    const { status, body } = await this.call<{ status?: RingOutStatus }>("GET", `/restapi/v1.0/account/~/extension/~/ring-out/${encodeURIComponent(id)}`);
    // RingCentral forgets finished sessions; the caller decides what that means for the call so far.
    if (status === 404) return { status: "completed" };
    if (status >= 300) throw new Error(`RingCentral status check failed (HTTP ${status})`);
    return mapRingOut(body?.status ?? {});
  }

  async cancel(id: string) {
    // Only possible while the salesperson's phone is still ringing.
    await this.call("DELETE", `/restapi/v1.0/account/~/extension/~/ring-out/${encodeURIComponent(id)}`);
  }

  /** Company users and their emails, to match extensions to CRM users (needs "Read Accounts"). */
  async extensions() {
    const out: { id: string; email: string | null }[] = [];
    let path: string | null = "/restapi/v1.0/account/~/extension?type=User&status=Enabled&perPage=1000";
    while (path) {
      const res: { status: number; body: ExtensionPage | null } = await this.call<ExtensionPage>("GET", path);
      const { status, body } = res;
      if (status >= 300) throw new Error(`RingCentral extension list failed (HTTP ${status})`);
      for (const r of body?.records ?? []) out.push({ id: String(r.id), email: r.contact?.email?.toLowerCase() ?? null });
      path = body?.navigation?.nextPage?.uri ? new URL(body.navigation.nextPage.uri).pathname + new URL(body.navigation.nextPage.uri).search : null;
    }
    return out;
  }

  /** A call recording (needs "Read Call Recording"). Only RingCentral's own hosts are fetched. */
  async recording(contentUri: string) {
    const url = new URL(contentUri);
    const platform = new URL(this.cfg.serverUrl);
    const trusted = url.host === platform.host || (url.protocol === "https:" && (url.hostname === "ringcentral.com" || url.hostname.endsWith(".ringcentral.com")));
    if (!trusted) throw new Error(`Refusing to fetch a recording from ${url.host}`);
    const get = async () => fetch(url, { headers: { Authorization: `Bearer ${await this.accessToken()}` }, signal: AbortSignal.timeout(60_000) });
    let res = await get();
    if (res.status === 401) {
      this.token = null;
      res = await get();
    }
    if (!res.ok) throw new Error(`RingCentral recording download failed (HTTP ${res.status})`);
    return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type")?.split(";")[0] ?? "audio/mpeg" };
  }

  /** Webhook subscription to account telephony sessions (needs "Webhook Subscriptions" and an admin JWT user). */
  async subscription(id: string) {
    const { status, body } = await this.call<{ id: string; status: string; expirationTime: string }>("GET", `/restapi/v1.0/subscription/${encodeURIComponent(id)}`);
    if (status === 404) return null;
    if (status >= 300 || !body) throw new Error(`RingCentral subscription check failed (HTTP ${status})`);
    return { id: body.id, status: body.status, expiresAt: new Date(body.expirationTime) };
  }

  async subscribe(address: string, verificationToken: string) {
    const { status, body } = await this.call<{ id: string; expirationTime: string; message?: string }>("POST", "/restapi/v1.0/subscription", {
      eventFilters: ["/restapi/v1.0/account/~/telephony/sessions"],
      deliveryMode: { transportType: "WebHook", address, verificationToken },
      expiresIn: 604_800,
    });
    if (status >= 300 || !body?.id) throw new Error(`RingCentral subscription failed (HTTP ${status}${body?.message ? `: ${body.message}` : ""})`);
    return { id: body.id, expiresAt: new Date(body.expirationTime) };
  }

  async renewSubscription(id: string) {
    const { status, body } = await this.call<{ id: string; expirationTime: string }>("POST", `/restapi/v1.0/subscription/${encodeURIComponent(id)}/renew`);
    if (status >= 300 || !body?.id) throw new Error(`RingCentral subscription renewal failed (HTTP ${status})`);
    return { id: body.id, expiresAt: new Date(body.expirationTime) };
  }

  /** Every call on the account in the window, from the company call log (needs "Read Call Log"). */
  async callLog(from: Date, to: Date) {
    const out: CallLogRecord[] = [];
    let page = 1;
    for (;;) {
      const q = new URLSearchParams({ view: "Simple", type: "Voice", dateFrom: from.toISOString(), dateTo: to.toISOString(), perPage: "250", page: String(page), showBlocked: "false" });
      const { status, body } = await this.call<{ records?: RcCallLogRecord[]; navigation?: { nextPage?: unknown } }>("GET", `/restapi/v1.0/account/~/call-log?${q}`);
      if (status >= 300) throw new Error(`RingCentral call log failed (HTTP ${status})`);
      for (const r of body?.records ?? []) out.push(toCallLogRecord(r));
      if (!body?.navigation?.nextPage || page >= 40) break;
      page++;
    }
    return out;
  }
}

// --- Call log ---------------------------------------------------------------------------------

/** One finished call from the phone system's call log (any phone: desk, app, mobile app). */
export interface CallLogRecord {
  id: string;
  sessionId: string | null;
  direction: "inbound" | "outbound";
  /** The customer's side of the call. */
  counterpart: string | null;
  /** Our side: the company number called (inbound) or the number we called from (outbound). */
  ourNumber: string | null;
  /** The phone-system extension that made or took the call, if any. */
  extensionId: string | null;
  startedAt: Date;
  durationSec: number;
  status: CallStatus;
  /** Plain-language result, e.g. "Missed" or "Voicemail". */
  outcome: string | null;
  recording: { id: string; contentUri: string } | null;
}

/** A phone system whose call log the CRM imports (RingCentral). */
export interface CallLogSource {
  extensions(): Promise<{ id: string; email: string | null }[]>;
  callLog(from: Date, to: Date): Promise<CallLogRecord[]>;
  /** Downloads a recording from its content URI (from the call-log record). */
  recording(contentUri: string): Promise<{ body: Buffer; contentType: string }>;
}

export const isCallLogSource = (p: TelephonyProvider): p is TelephonyProvider & CallLogSource => typeof (p as Partial<CallLogSource>).callLog === "function";

interface ExtensionPage {
  records?: { id: string | number; contact?: { email?: string } }[];
  navigation?: { nextPage?: { uri: string } };
}

interface RcParty {
  phoneNumber?: string;
  extensionId?: string;
}
interface RcCallLogRecord {
  id: string;
  sessionId?: string;
  startTime: string;
  duration?: number;
  direction?: "Inbound" | "Outbound";
  result?: string;
  from?: RcParty;
  to?: RcParty;
  extension?: { id?: string | number };
  recording?: { id: string | number; contentUri: string };
}

const CONNECTED = new Set(["Accepted", "Call connected", "Answered Not Accepted", "Reply"]);

/** Maps a RingCentral call-log result to our status and wording. */
export function mapCallLogResult(result: string | undefined, durationSec: number): { status: CallStatus; outcome: string | null } {
  const r = result ?? "";
  if (CONNECTED.has(r) || (durationSec > 0 && !["Missed", "Voicemail", "Busy", "Rejected", "No Answer"].includes(r))) return { status: "completed", outcome: null };
  if (r === "Busy") return { status: "busy", outcome: "Busy" };
  if (r === "Voicemail") return { status: "no_answer", outcome: "Left a voicemail" };
  if (["Missed", "No Answer", "Hang Up", "Rejected", "Abandoned"].includes(r)) return { status: "no_answer", outcome: r === "Missed" ? "Missed" : "Not answered" };
  return { status: "failed", outcome: r || null };
}

export function toCallLogRecord(r: RcCallLogRecord): CallLogRecord {
  const inbound = r.direction === "Inbound";
  const durationSec = r.duration ?? 0;
  const ours = inbound ? r.to : r.from;
  const { status, outcome } = mapCallLogResult(r.result, durationSec);
  return {
    id: String(r.id),
    sessionId: r.sessionId ? String(r.sessionId) : null,
    direction: inbound ? "inbound" : "outbound",
    counterpart: (inbound ? r.from : r.to)?.phoneNumber ?? null,
    ourNumber: ours?.phoneNumber ?? null,
    extensionId: ours?.extensionId ? String(ours.extensionId) : r.extension?.id != null ? String(r.extension.id) : null,
    startedAt: new Date(r.startTime),
    durationSec,
    status,
    outcome,
    recording: r.recording ? { id: String(r.recording.id), contentUri: r.recording.contentUri } : null,
  };
}

// --- Live call events -----------------------------------------------------------------------

/** A phone system that can push live call events to the CRM (RingCentral webhook subscriptions). */
export interface TelephonyEventSource {
  subscription(id: string): Promise<{ id: string; status: string; expiresAt: Date } | null>;
  subscribe(address: string, verificationToken: string): Promise<{ id: string; expiresAt: Date }>;
  renewSubscription(id: string): Promise<{ id: string; expiresAt: Date }>;
}

export const isEventSource = (p: TelephonyProvider): p is TelephonyProvider & TelephonyEventSource => typeof (p as Partial<TelephonyEventSource>).subscribe === "function";
