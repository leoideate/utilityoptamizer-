import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

type Status = { callStatus: string; callerStatus: string; calleeStatus: string };

/**
 * Minimal RingCentral platform: JWT token endpoint and RingOut create / status / cancel.
 * Each call follows a scripted list of statuses; every status check advances one step.
 */
export class MockRingCentral {
  url = "";
  readonly clientId = "rc-client";
  readonly clientSecret = "rc-secret";
  readonly jwt = "rc-jwt-credential";
  private server!: Server;
  private nextScript: Status[] = [];
  private readonly calls = new Map<string, { script: Status[]; step: number; cancelled: boolean }>();
  readonly ringOuts: { from: string; to: string; callerId?: string; playPrompt?: boolean }[] = [];
  tokenRequests = 0;

  /** The statuses the next RingOut will go through. */
  script(...steps: [caller: string, callee: string, call?: string][]) {
    this.nextScript = steps.map(([callerStatus, calleeStatus, callStatus]) => ({ callerStatus, calleeStatus, callStatus: callStatus ?? "InProgress" }));
  }

  async start() {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const json = (status: number, body?: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(body === undefined ? "" : JSON.stringify(body));
        };
        const url = req.url ?? "";
        if (url === "/restapi/oauth/token" && req.method === "POST") {
          const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
          const p = new URLSearchParams(raw);
          if (req.headers.authorization !== `Basic ${basic}` || p.get("assertion") !== this.jwt || p.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return json(401, { error: "invalid_client" });
          this.tokenRequests++;
          return json(200, { access_token: "rc-access", expires_in: 3600 });
        }
        if (req.headers.authorization !== "Bearer rc-access") return json(401, { message: "Unauthorized" });
        const base = "/restapi/v1.0/account/~/extension/~/ring-out";
        if (url === base && req.method === "POST") {
          const b = JSON.parse(raw);
          this.ringOuts.push({ from: b.from?.phoneNumber, to: b.to?.phoneNumber, callerId: b.callerId?.phoneNumber, playPrompt: b.playPrompt });
          const id = String(1000 + this.ringOuts.length);
          this.calls.set(id, { script: this.nextScript, step: 0, cancelled: false });
          return json(200, { id, uri: `${base}/${id}`, status: { callStatus: "InProgress", callerStatus: "InProgress", calleeStatus: "InProgress" } });
        }
        const m = url.match(/\/ring-out\/(\d+)$/);
        const call = m && this.calls.get(m[1]);
        if (!call) return json(404, { message: "Not found" });
        if (req.method === "DELETE") {
          call.cancelled = true;
          return json(204);
        }
        if (call.step >= call.script.length) return json(404, { message: "Session not found" });
        return json(200, { id: m![1], status: call.script[call.step++] });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}
