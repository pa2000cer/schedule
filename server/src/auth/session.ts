/**
 * Signed-cookie session for the single-user app.
 *
 * Mechanism: a stateless JSON Web Token (HS256) signed with SESSION_SECRET,
 * stored in an httpOnly cookie. No server-side session store is needed for a
 * single user, and the token can be minted/verified anywhere the secret is
 * available (which is what the T15 Cloud Run secret wiring will provide).
 *
 * The session also stashes the Google OAuth tokens so the T5 Calendar layer
 * can call the Google Calendar API on the user's behalf without re-consent.
 */
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";

export const SESSION_COOKIE = "pc_session";

/** 7-day session lifetime. */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The application session payload. Google tokens are kept here (encrypted at
 * rest only insofar as the JWT is signed, not encrypted — acceptable because
 * the cookie is httpOnly and this is a single-user app; revisit if multi-user).
 */
export interface SessionData {
  /** Verified Google account email (the allowlisted identity). */
  email: string;
  /** Google OAuth access token for Calendar API calls (T5). */
  googleAccessToken?: string;
  /** Google OAuth refresh token (issued via access_type=offline + prompt=consent). */
  googleRefreshToken?: string;
  /** Access-token expiry as epoch milliseconds, if known. */
  googleTokenExpiry?: number;
}

/**
 * Read SESSION_SECRET, failing loudly if it is missing. Never fall back to a
 * hardcoded default — an unsigned/weakly-signed session would defeat the
 * allowlist entirely.
 */
function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      "SESSION_SECRET is not set. Refusing to sign/verify sessions without it.",
    );
  }
  return secret;
}

/** True when we should mark cookies Secure (HTTPS-only). */
function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Mint a signed session token for the given data.
 * Exported so tests (and future callers) can reproduce the exact signing.
 */
export function signSession(data: SessionData): string {
  return jwt.sign(data, getSecret(), {
    algorithm: "HS256",
    expiresIn: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
}

/**
 * Verify and decode a session token. Returns null on any failure (bad
 * signature, expired, malformed, missing email).
 */
export function verifySession(token: string | undefined | null): SessionData | null {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, getSecret(), { algorithms: ["HS256"] });
    if (typeof decoded !== "object" || decoded === null) return null;
    const email = (decoded as Record<string, unknown>).email;
    if (typeof email !== "string" || email.length === 0) return null;
    const d = decoded as Record<string, unknown>;
    return {
      email,
      googleAccessToken:
        typeof d.googleAccessToken === "string" ? d.googleAccessToken : undefined,
      googleRefreshToken:
        typeof d.googleRefreshToken === "string" ? d.googleRefreshToken : undefined,
      googleTokenExpiry:
        typeof d.googleTokenExpiry === "number" ? d.googleTokenExpiry : undefined,
    };
  } catch {
    return null;
  }
}

/** Write the session cookie on the response. */
export function setSessionCookie(res: Response, data: SessionData): void {
  const token = signSession(data);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
}

/** Clear the session cookie (logout). */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
  });
}

/** Read + verify the session from the request cookies. Returns null if absent/invalid. */
export function readSession(req: Request): SessionData | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const token = cookies ? cookies[SESSION_COOKIE] : undefined;
  return verifySession(token);
}
