/**
 * Pure, side-effect-free allowlist decision for the single-user app.
 *
 * Only the configured ALLOWED_EMAIL, with a Google-verified email, may sign in.
 * Kept as a standalone pure function so it can be unit-tested directly and
 * reused by both the OAuth callback and the per-request auth middleware.
 */

/**
 * Read the allowed email from the environment, normalized (trimmed, lowercased).
 * Returns undefined if unset/empty so callers can fail closed.
 */
export function getAllowedEmail(): string | undefined {
  const raw = process.env.ALLOWED_EMAIL;
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Decide whether a given Google identity may access the app.
 *
 * @param email          The email claim from the verified Google ID token.
 * @param emailVerified  The `email_verified` claim from the ID token.
 * @param allowedEmail   Override the allowlist target (defaults to ALLOWED_EMAIL env).
 * @returns true only when the email matches the allowlist AND Google verified it.
 *
 * Fails closed: unverified emails, missing emails, and a missing/empty
 * ALLOWED_EMAIL configuration all return false.
 */
export function isAllowed(
  email: string | null | undefined,
  emailVerified: boolean | null | undefined,
  allowedEmail: string | undefined = getAllowedEmail(),
): boolean {
  if (!allowedEmail) return false;
  if (!email) return false;
  if (emailVerified !== true) return false;
  return email.trim().toLowerCase() === allowedEmail;
}
