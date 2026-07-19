/**
 * Google OAuth2 client factory and scope definitions.
 *
 * A fresh OAuth2Client is created per request-flow so we never share mutable
 * credential state between requests. Config comes entirely from the environment.
 */
import { OAuth2Client } from "google-auth-library";

/**
 * OAuth scopes requested at consent. `openid email profile` for identity;
 * calendar.events + calendar.readonly for the T5 Calendar feature.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

/** The OAuth client id (also used as the ID-token verification audience). */
export function getClientId(): string {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!id) throw new Error("GOOGLE_CLIENT_ID is not set.");
  return id;
}

function getClientSecret(): string {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) throw new Error("GOOGLE_CLIENT_SECRET is not set.");
  return secret;
}

function getRedirectUri(): string {
  const uri = process.env.GOOGLE_REDIRECT_URI;
  if (!uri) throw new Error("GOOGLE_REDIRECT_URI is not set.");
  return uri;
}

/** Build a configured OAuth2Client from environment config. */
export function createOAuthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: getClientId(),
    clientSecret: getClientSecret(),
    redirectUri: getRedirectUri(),
  });
}
