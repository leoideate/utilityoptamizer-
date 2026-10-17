import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import type { Role } from "@uo/shared";
import { ENV, type Env } from "../config/env";
import { AuditService } from "../audit/audit.service";
import type { Actor } from "../common/actor";
import { CryptoService } from "../common/crypto.service";
import { PrismaService } from "../common/prisma.service";
import { AuthService } from "./auth.service";

export type SsoProviderId = "microsoft" | "google";

interface ProviderConfig {
  id: SsoProviderId;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  extraParams: Record<string, string>;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

/** Why an SSO attempt failed. The code is shown on the login page as a friendly message. */
export type SsoErrorCode = "sso_unavailable" | "sso_cancelled" | "sso_expired" | "sso_failed" | "sso_no_account" | "sso_domain" | "sso_unverified";

export class SsoError extends Error {
  constructor(
    public readonly code: SsoErrorCode,
    detail: string,
  ) {
    super(detail);
  }
}

export interface FlowState {
  provider: SsoProviderId;
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  exp: number;
}

export interface PendingMfa {
  userId: string;
  provider: SsoProviderId;
  next: string;
  exp: number;
}

const FLOW_TTL_SECONDS = 600;
const MFA_TTL_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 120;
const CACHE_MS = 3_600_000;

const b64url = (b: Buffer) => b.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

/** Only same-site relative paths are allowed as post-login destinations. */
export const safeNext = (next: unknown) => (typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next.slice(0, 500) : "/");

/**
 * Verifies an OpenID Connect ID token: RS256 signature against the provider's published keys,
 * issuer, audience, expiry/issued-at (with skew) and the nonce from our sign-in request.
 */
export function verifyIdToken(
  idToken: string,
  opts: { issuer: string; clientId: string; nonce: string; keys: JsonWebKey[]; now?: number },
): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new SsoError("sso_failed", "ID token is not a JWT");
  const header = JSON.parse(fromB64url(parts[0]).toString()) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new SsoError("sso_failed", `Unsupported ID token algorithm ${header.alg}`);
  const jwk = opts.keys.find((k) => (k as { kid?: string }).kid === header.kid) ?? (opts.keys.length === 1 && !header.kid ? opts.keys[0] : undefined);
  if (!jwk) throw new SsoError("sso_failed", "ID token signed with an unknown key");
  const ok = verifySignature("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: "jwk" }), fromB64url(parts[2]));
  if (!ok) throw new SsoError("sso_failed", "ID token signature is invalid");

  const c = JSON.parse(fromB64url(parts[1]).toString()) as Record<string, unknown>;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (c.iss !== opts.issuer) throw new SsoError("sso_failed", "ID token issuer mismatch");
  if (!aud.includes(opts.clientId)) throw new SsoError("sso_failed", "ID token audience mismatch");
  if (Array.isArray(c.aud) && c.aud.length > 1 && c.azp !== opts.clientId) throw new SsoError("sso_failed", "ID token authorized party mismatch");
  if (typeof c.exp !== "number" || c.exp < now - CLOCK_SKEW_SECONDS) throw new SsoError("sso_failed", "ID token expired");
  if (typeof c.iat === "number" && c.iat > now + CLOCK_SKEW_SECONDS) throw new SsoError("sso_failed", "ID token issued in the future");
  if (c.nonce !== opts.nonce) throw new SsoError("sso_failed", "ID token nonce mismatch");
  return c;
}

/**
 * OpenID Connect single sign-on with Microsoft Entra ID and Google (authorization code + PKCE).
 * Signs in existing, active CRM users only, matched by verified email. Flow state lives in a
 * short-lived, HMAC-signed, HTTP-only cookie, so no server-side storage is needed.
 */
@Injectable()
export class SsoService {
  private readonly log = new Logger(SsoService.name);
  private readonly discovery = new Map<string, { doc: Discovery; at: number }>();
  private readonly jwks = new Map<string, { keys: JsonWebKey[]; at: number }>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  providers(): ProviderConfig[] {
    const e = this.env;
    const list: ProviderConfig[] = [];
    if (e.SSO_MICROSOFT_CLIENT_ID && e.SSO_MICROSOFT_CLIENT_SECRET) {
      list.push({
        id: "microsoft",
        label: "Microsoft",
        issuer: e.SSO_MICROSOFT_ISSUER ?? `https://login.microsoftonline.com/${e.SSO_MICROSOFT_TENANT_ID}/v2.0`,
        clientId: e.SSO_MICROSOFT_CLIENT_ID,
        clientSecret: e.SSO_MICROSOFT_CLIENT_SECRET,
        extraParams: { prompt: "select_account" },
      });
    }
    if (e.SSO_GOOGLE_CLIENT_ID && e.SSO_GOOGLE_CLIENT_SECRET) {
      const domains = this.allowedDomains();
      list.push({
        id: "google",
        label: "Google",
        issuer: e.SSO_GOOGLE_ISSUER,
        clientId: e.SSO_GOOGLE_CLIENT_ID,
        clientSecret: e.SSO_GOOGLE_CLIENT_SECRET,
        // hd pre-selects the Workspace domain; it's a hint only, the domain is checked again on return.
        extraParams: { prompt: "select_account", ...(domains.length === 1 ? { hd: domains[0] } : {}) },
      });
    }
    return list;
  }

  private provider(id: string): ProviderConfig {
    const p = this.providers().find((x) => x.id === id);
    if (!p) throw new SsoError("sso_unavailable", `SSO provider ${id} is not configured`);
    return p;
  }

  private allowedDomains(): string[] {
    return (this.env.SSO_ALLOWED_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);
  }

  /** Why this email couldn't sign in with SSO right now, or null if it could (a provider is set up and the domain is allowed). */
  unavailableFor(email: string): string | null {
    if (this.providers().length === 0) return "Single sign-on isn't set up.";
    const domains = this.allowedDomains();
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    if (domains.length && !domains.includes(domain)) return `Single sign-on isn't allowed for ${domain} addresses.`;
    return null;
  }

  redirectUri(id: SsoProviderId) {
    return `${this.env.WEB_ORIGIN}/api/auth/sso/${id}/callback`;
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new SsoError("sso_failed", `${new URL(url).host} returned HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async discover(p: ProviderConfig): Promise<Discovery> {
    const cached = this.discovery.get(p.issuer);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.doc;
    const doc = await this.fetchJson<Discovery>(`${p.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (doc.issuer !== p.issuer) throw new SsoError("sso_failed", "Discovery issuer doesn't match the configured issuer");
    this.discovery.set(p.issuer, { doc, at: Date.now() });
    return doc;
  }

  private async keys(jwksUri: string, refresh = false): Promise<JsonWebKey[]> {
    const cached = this.jwks.get(jwksUri);
    if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached.keys;
    const { keys } = await this.fetchJson<{ keys: JsonWebKey[] }>(jwksUri);
    this.jwks.set(jwksUri, { keys, at: Date.now() });
    return keys;
  }

  // --- Signed cookies ---------------------------------------------------------------

  seal(value: object): string {
    const body = b64url(Buffer.from(JSON.stringify(value)));
    return `${body}.${this.crypto.sign(`sso|${body}`)}`;
  }

  unseal<T extends { exp: number }>(cookie: string | undefined): T | null {
    if (!cookie) return null;
    const [body, sig] = cookie.split(".");
    if (!body || !sig || !/^[0-9a-f]+$/.test(sig) || !this.crypto.verify(`sso|${body}`, sig)) return null;
    const v = JSON.parse(fromB64url(body).toString()) as T;
    return v.exp > Math.floor(Date.now() / 1000) ? v : null;
  }

  // --- Flow ----------------------------------------------------------------------------

  /** Builds the provider's sign-in URL and the flow cookie (state, nonce, PKCE verifier). */
  async start(id: string, next: string): Promise<{ url: string; cookie: string; maxAgeMs: number }> {
    const p = this.provider(id);
    const d = await this.discover(p);
    const flow: FlowState = {
      provider: p.id,
      state: CryptoService.token(24),
      nonce: CryptoService.token(24),
      verifier: CryptoService.token(48),
      next: safeNext(next),
      exp: Math.floor(Date.now() / 1000) + FLOW_TTL_SECONDS,
    };
    const url = new URL(d.authorization_endpoint);
    const params = {
      client_id: p.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri(p.id),
      scope: "openid email profile",
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: b64url(createHash("sha256").update(flow.verifier).digest()),
      code_challenge_method: "S256",
      ...p.extraParams,
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return { url: url.toString(), cookie: this.seal(flow), maxAgeMs: FLOW_TTL_SECONDS * 1000 };
  }

  /**
   * Handles the provider's redirect back. Returns a session, or (for users with two-factor
   * authentication that the provider didn't satisfy) a pending-MFA cookie.
   */
  async callback(
    id: string,
    q: { code?: string; state?: string; error?: string },
    flowCookie: string | undefined,
    meta: { ip?: string; userAgent?: string },
  ): Promise<{ kind: "session"; session: Awaited<ReturnType<AuthService["issueSession"]>>; next: string } | { kind: "mfa"; cookie: string; next: string }> {
    const anon: Actor = { id: "00000000-0000-0000-0000-000000000000", name: "anonymous", roles: [], ip: meta.ip };
    try {
      const p = this.provider(id);
      if (q.error) throw new SsoError("sso_cancelled", `Provider returned error ${q.error}`);
      const flow = this.unseal<FlowState>(flowCookie);
      if (!flow || flow.provider !== p.id || !q.state || flow.state !== q.state || !q.code) throw new SsoError("sso_expired", "Missing or mismatched SSO state");

      const d = await this.discover(p);
      const tokens = await this.fetchJson<{ id_token?: string }>(d.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: q.code,
          redirect_uri: this.redirectUri(p.id),
          client_id: p.clientId,
          client_secret: p.clientSecret,
          code_verifier: flow.verifier,
        }),
      });
      if (!tokens.id_token) throw new SsoError("sso_failed", "Token response has no ID token");
      let claims: Record<string, unknown>;
      try {
        claims = verifyIdToken(tokens.id_token, { issuer: p.issuer, clientId: p.clientId, nonce: flow.nonce, keys: await this.keys(d.jwks_uri) });
      } catch (e) {
        if (!(e instanceof SsoError) || !/unknown key/.test(e.message)) throw e;
        // The provider may have rotated keys since we cached them.
        claims = verifyIdToken(tokens.id_token, { issuer: p.issuer, clientId: p.clientId, nonce: flow.nonce, keys: await this.keys(d.jwks_uri, true) });
      }

      const email = this.emailFrom(p.id, claims);
      const domains = this.allowedDomains();
      if (domains.length && !domains.includes(email.split("@")[1])) throw new SsoError("sso_domain", `Domain of ${email} isn't allowed for SSO`);

      const user = await this.prisma.user.findUnique({ where: { email }, include: { roles: true } });
      if (!user || !user.active) throw new SsoError("sso_no_account", `No active CRM user for ${email}`);
      const actor: Actor = { id: user.id, name: user.name, roles: user.roles.map((r) => r.role as Role), ip: meta.ip };

      // Users with CRM two-factor on still need it, unless Microsoft asserts MFA was performed.
      const idpMfa = Array.isArray(claims.amr) && (claims.amr as unknown[]).includes("mfa");
      if (user.mfaEnabled && !idpMfa) {
        const pending: PendingMfa = { userId: user.id, provider: p.id, next: flow.next, exp: Math.floor(Date.now() / 1000) + MFA_TTL_SECONDS };
        return { kind: "mfa", cookie: this.seal(pending), next: flow.next };
      }
      const session = await this.auth.issueSession(user.id, actor, { ...meta, method: "sso", provider: p.label });
      return { kind: "session", session, next: flow.next };
    } catch (e) {
      const err = e instanceof SsoError ? e : new SsoError("sso_failed", (e as Error).message);
      this.log.warn({ provider: id, code: err.code, reason: err.message }, "SSO sign-in failed");
      await this.audit.log(anon, { action: "auth.sso_failed", entityType: "user", summary: `SSO sign-in failed (${id}): ${err.code}`, data: { provider: id, reason: err.message.slice(0, 200) } });
      throw err;
    }
  }

  /** Second step for SSO users with two-factor on: check the TOTP code, then create the session. */
  async completeMfa(pendingCookie: string | undefined, code: string, meta: { ip?: string; userAgent?: string }) {
    const pending = this.unseal<PendingMfa>(pendingCookie);
    if (!pending) throw new SsoError("sso_expired", "No pending SSO sign-in");
    const user = await this.prisma.user.findUnique({ where: { id: pending.userId }, include: { roles: true } });
    if (!user || !user.active) throw new SsoError("sso_no_account", "User no longer active");
    const actor: Actor = { id: user.id, name: user.name, roles: user.roles.map((r) => r.role as Role), ip: meta.ip };
    await this.auth.checkTotp(user, actor, code);
    const provider = this.providers().find((p) => p.id === pending.provider)?.label ?? pending.provider;
    return { session: await this.auth.issueSession(user.id, actor, { ...meta, method: "sso", provider }), next: pending.next };
  }

  /**
   * The verified email address. Google: requires email_verified. Microsoft: the account belongs
   * to the configured tenant (checked via the issuer), so the tenant's email / UPN is trusted.
   */
  private emailFrom(provider: SsoProviderId, c: Record<string, unknown>): string {
    const raw = provider === "google" ? (c.email_verified === true ? c.email : undefined) : (c.email ?? c.preferred_username);
    if (typeof raw !== "string" || !raw.includes("@")) throw new SsoError("sso_unverified", "The provider didn't return a verified email address");
    return raw.trim().toLowerCase();
  }
}
