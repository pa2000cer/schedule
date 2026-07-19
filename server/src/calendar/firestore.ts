/**
 * Firestore client singleton (T19).
 *
 * The calendar/event store is backed by **Firestore** (Google Cloud, project
 * `tv-api-gc`) instead of Google Calendar. On Cloud Run the client authenticates
 * via **Application Default Credentials** (the runtime service account) — no key
 * file, no per-request user token. Locally it uses ADC from
 * `gcloud auth application-default login`, and honours `FIRESTORE_EMULATOR_HOST`
 * automatically when set (hermetic tests).
 *
 * Follows the same module-level-singleton seam convention as
 * `mcp/tools/context.ts`: a lazily-constructed shared client, with `setDb()` as a
 * test/smoke override. Single-user / single-instance design.
 */
import { Firestore } from "@google-cloud/firestore";

let db: Firestore | null = null;

/** Lazily construct (or return) the shared Firestore client via ADC. */
export function getDb(): Firestore {
  if (!db) {
    db = new Firestore({
      projectId: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "tv-api-gc",
    });
  }
  return db;
}

/** Override the client (tests/smoke), or pass `null` to reset to lazy ADC. */
export function setDb(override: Firestore | null): void {
  db = override;
}
