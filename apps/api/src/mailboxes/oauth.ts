import type { MailProviderId } from "@prisma/client";
import type { Env } from "../config/env";

/** Delegated scopes: read and send the user's own mail, and a refresh token to keep syncing. */
const SCOPES: Record<MailProviderId, string> = {
  microsoft: "offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read",
  google: "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send",
};

export interface MailTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** The provider refused the refresh token: the owner has to connect the mailbox again. */
export class MailReauthRequired extends Error {}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

/**
 * OAuth 2.0 authorization code + PKCE against the same Entra ID / Google app registrations used for
 * single sign-on, with mail scopes and offline access. Endpoints come from OpenID discovery.
 */
export class MailOAuth {
  private readonly discovery = new Map<string, { doc: Discovery; at: number }>();

  constructor(private readonly env: Env) {}

  private client(p: MailProviderId) {
    const e = this.env;
    if (p === "microsoft") {
      if (!e.SSO_MICROSOFT_CLIENT_ID || !e.SSO_MICROSOFT_CLIENT_SECRET) return null;
      return { id: e.SSO_MICROSOFT_CLIENT_ID, secret: e.SSO_MICROSOFT_CLIENT_SECRET, issuer: e.SSO_MICROSOFT_ISSUER ?? `https://login.microsoftonline.com/${e.SSO_MICROSOFT_TENANT_ID}/v2.0` };
    }
    if (!e.SSO_GOOGLE_CLIENT_ID || !e.SSO_GOOGLE_CLIENT_SECRET) return null;
    return { id: e.SSO_GOOGLE_CLIENT_ID, secret: e.SSO_GOOGLE_CLIENT_SECRET, issuer: e.SSO_GOOGLE_ISSUER };
  }

  configured(p: MailProviderId) {
    return this.client(p) !== null;
  }

  redirectUri(p: MailProviderId) {
    return `${this.env.WEB_ORIGIN}/api/mailboxes/${p}/callback`;
  }

  private async endpoints(p: MailProviderId) {
    const c = this.client(p);
    if (!c) throw new Error(`${p} mailboxes aren't configured`);
    const cached = this.discovery.get(c.issuer);
    if (cached && Date.now() - cached.at < 3_600_000) return { c, d: cached.doc };
    const res = await fetch(`${c.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Discovery for ${p} returned HTTP ${res.status}`);
    const doc = (await res.json()) as Discovery;
    this.discovery.set(c.issuer, { doc, at: Date.now() });
    return { c, d: doc };
  }

  async authorizeUrl(p: MailProviderId, opts: { state: string; challenge: string; loginHint: string }) {
    const { c, d } = await this.endpoints(p);
    const url = new URL(d.authorization_endpoint);
    const params: Record<string, string> = {
      client_id: c.id,
      response_type: "code",
      redirect_uri: this.redirectUri(p),
      scope: SCOPES[p],
      state: opts.state,
      code_challenge: opts.challenge,
      code_challenge_method: "S256",
      login_hint: opts.loginHint,
      // Google only returns a refresh token with offline access and a fresh consent.
      ...(p === "google" ? { access_type: "offline", prompt: "consent" } : { prompt: "select_account" }),
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private async token(p: MailProviderId, form: Record<string, string>): Promise<MailTokens & { refreshToken: string | null }> {
    const { c, d } = await this.endpoints(p);
    const res = await fetch(d.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...form }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      if (body.error === "invalid_grant") throw new MailReauthRequired(`${p} refused the grant`);
      throw new Error(`${p} token endpoint returned HTTP ${res.status}${body.error ? ` (${body.error})` : ""}`);
    }
    return { accessToken: body.access_token, refreshToken: body.refresh_token ?? null, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 } as MailTokens & { refreshToken: string | null };
  }

  async exchange(p: MailProviderId, code: string, verifier: string): Promise<MailTokens> {
    const t = await this.token(p, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: this.redirectUri(p), ...(p === "microsoft" ? { scope: SCOPES[p] } : {}) });
    if (!t.refreshToken) throw new Error(`${p} didn't return a refresh token`);
    return t as MailTokens;
  }

  /** Providers may rotate the refresh token; keep the old one when they don't send a new one. */
  async refresh(p: MailProviderId, refreshToken: string): Promise<MailTokens> {
    const t = await this.token(p, { grant_type: "refresh_token", refresh_token: refreshToken, ...(p === "microsoft" ? { scope: SCOPES[p] } : {}) });
    return { accessToken: t.accessToken, refreshToken: t.refreshToken ?? refreshToken, expiresAt: t.expiresAt };
  }
}
