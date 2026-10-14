import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

interface PendingCode {
  claims: Record<string, unknown>;
  challenge: string;
  tamper?: "signature";
}

/**
 * A minimal OpenID Connect provider for tests: discovery, JWKS and a token endpoint that checks
 * the client secret and PKCE verifier, then returns an RS256-signed ID token.
 */
export class MockOidcProvider {
  issuer = "";
  readonly clientId: string;
  readonly clientSecret: string;
  private server!: Server;
  private readonly key: { privateKey: KeyObject; publicKey: KeyObject };
  private readonly codes = new Map<string, PendingCode>();
  readonly kid = "test-key-1";
  tokenRequests: URLSearchParams[] = [];

  constructor(
    private readonly path: string,
    clientId: string,
  ) {
    this.clientId = clientId;
    this.clientSecret = `${clientId}-secret`;
    this.key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", this.issuer);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === `${this.path}/.well-known/openid-configuration`) {
        return json(200, { issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks` });
      }
      if (url.pathname === `${this.path}/jwks`) {
        return json(200, { keys: [{ ...this.key.publicKey.export({ format: "jwk" }), kid: this.kid, use: "sig", alg: "RS256" }] });
      }
      if (url.pathname === `${this.path}/token` && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          const p = new URLSearchParams(raw);
          this.tokenRequests.push(p);
          const pending = this.codes.get(p.get("code") ?? "");
          if (!pending || p.get("client_id") !== this.clientId || p.get("client_secret") !== this.clientSecret) return json(400, { error: "invalid_grant" });
          const challenge = createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
          if (challenge !== pending.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
          this.codes.delete(p.get("code")!);
          json(200, { id_token: this.sign(pending.claims, pending.tamper), token_type: "Bearer" });
        });
        return;
      }
      json(404, {});
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}${this.path}`;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  /** What the user "does" at the provider: approve sign-in, producing a code for these claims. */
  issueCode(authorizeUrl: string, claims: Record<string, unknown>, tamper?: "signature"): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    const now = Math.floor(Date.now() / 1000);
    const code = `code-${Math.random().toString(36).slice(2)}`;
    this.codes.set(code, {
      challenge: u.searchParams.get("code_challenge")!,
      tamper,
      claims: { iss: this.issuer, aud: this.clientId, iat: now, exp: now + 600, nonce: u.searchParams.get("nonce"), sub: "user-1", ...claims },
    });
    return { code, state: u.searchParams.get("state")! };
  }

  sign(claims: Record<string, unknown>, tamper?: "signature"): string {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const input = `${enc({ alg: "RS256", typ: "JWT", kid: this.kid })}.${enc(claims)}`;
    let sig = createSign("RSA-SHA256").update(input).sign(this.key.privateKey).toString("base64url");
    if (tamper === "signature") sig = sig.slice(0, -4) + (sig.endsWith("AAAA") ? "BBBB" : "AAAA");
    return `${input}.${sig}`;
  }
}
