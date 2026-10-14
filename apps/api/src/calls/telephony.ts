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
}
