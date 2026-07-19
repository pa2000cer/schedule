/**
 * Google OAuth 2.0 authentication routes.
 *
 *   GET /auth/google/login    → 302 to Google consent screen (with CSRF state)
 *   GET /auth/google/callback → exchange code, verify ID token, enforce allowlist,
 *                               create session, redirect to /
 *   GET /auth/logout          → clear session, redirect to /
 *   GET /api/me               → protected; returns { email } of current session
 *
 * All /auth/* routes are public (they are the way IN); /api/me is protected by
 * requireAuth. The allowlist decision is made by the pure isAllowed() function.
 */
import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { isAllowed } from "../auth/allowlist";
import { createOAuthClient, getClientId, GOOGLE_SCOPES } from "../auth/google";
import { requireAuth } from "../auth/requireAuth";
import { clearSessionCookie, setSessionCookie } from "../auth/session";

export const authRouter = Router();

const STATE_COOKIE = "pc_oauth_state";
const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * GET /auth/google/login
 * Generate a random state (CSRF), stash it in a short-lived httpOnly cookie,
 * and redirect the browser to the Google consent screen.
 */
authRouter.get("/auth/google/login", (_req: Request, res: Response) => {
  try {
    const client = createOAuthClient();
    const state = crypto.randomBytes(32).toString("hex");

    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction(),
      maxAge: STATE_MAX_AGE_MS,
      path: "/",
    });

    const url = client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE_SCOPES,
      state,
      include_granted_scopes: true,
    });

    res.redirect(url);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth] login error:", err);
    res.status(500).json({ error: "auth_configuration_error" });
  }
});

/**
 * GET /auth/google/callback
 * Validate state, exchange the code for tokens, verify the ID token, enforce
 * the allowlist, and (only if allowed) create a session.
 */
authRouter.get("/auth/google/callback", async (req: Request, res: Response) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      res.status(400).send(`Google sign-in was cancelled or failed: ${String(oauthError)}`);
      return;
    }

    // --- CSRF: state must match the cookie we set at /login ---
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
    const expectedState = cookies[STATE_COOKIE];
    // Clear the one-time state cookie regardless of outcome.
    res.clearCookie(STATE_COOKIE, { path: "/" });

    if (
      typeof state !== "string" ||
      typeof expectedState !== "string" ||
      expectedState.length === 0 ||
      state !== expectedState
    ) {
      res.status(400).send("Invalid or missing OAuth state. Please try signing in again.");
      return;
    }

    if (typeof code !== "string" || code.length === 0) {
      res.status(400).send("Missing authorization code.");
      return;
    }

    // --- Exchange the code for tokens ---
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);

    if (!tokens.id_token) {
      res.status(400).send("Google did not return an ID token.");
      return;
    }

    // --- Verify the ID token (audience = our client id) ---
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: getClientId(),
    });
    const payload = ticket.getPayload();

    const email = payload?.email;
    const emailVerified = payload?.email_verified === true;

    // --- Allowlist enforcement (pure decision function) ---
    if (!isAllowed(email, emailVerified)) {
      // Do NOT create a session.
      res
        .status(403)
        .send(
          "Access denied. This is a private, single-user application and your " +
            "Google account is not authorized to sign in.",
        );
      return;
    }

    // --- Allowed: create the signed session, stashing Google tokens for T5 ---
    setSessionCookie(res, {
      email: email as string,
      googleAccessToken: tokens.access_token ?? undefined,
      googleRefreshToken: tokens.refresh_token ?? undefined,
      googleTokenExpiry: tokens.expiry_date ?? undefined,
    });

    res.redirect("/");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[auth] callback error:", err);
    res.status(500).send("Authentication failed. Please try again.");
  }
});

/**
 * GET /auth/logout — clear the session cookie and return to /.
 */
authRouter.get("/auth/logout", (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.redirect("/");
});

/**
 * GET /api/me — protected. Returns the current session's email.
 * requireAuth guarantees a valid, allowlisted session before this runs.
 */
authRouter.get("/api/me", requireAuth, (req: Request, res: Response) => {
  res.status(200).json({ email: req.session?.email });
});
