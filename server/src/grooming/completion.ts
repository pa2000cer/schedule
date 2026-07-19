/**
 * Grooming done-state persistence (T29b).
 *
 * The grooming routine (T8) is a static, code-defined daily list, so its items
 * aren't Firestore events and their checkmarks previously lived only in browser
 * memory (lost on reload). This stores per-day completion in Firestore
 * `groomingDone/{YYYY-MM-DD}` = { done: [id, ...] }, keyed by a stable grooming id.
 */
import { getDb } from "../calendar/firestore";
import { FieldValue } from "@google-cloud/firestore";

function ref(dateStr: string) {
  return getDb().collection("groomingDone").doc(dateStr);
}

/** Stable id for a grooming item on a given day. */
export function groomingId(time: string, title: string): string {
  return `${time}|${title}`;
}

/** The set of completed grooming ids for a date. */
export async function getGroomingDone(dateStr: string): Promise<Set<string>> {
  const snap = await ref(dateStr).get();
  const done = snap.exists ? ((snap.data()?.done as string[]) ?? []) : [];
  return new Set(done);
}

/** Mark a grooming item done/undone for a date (persisted). */
export async function setGroomingDone(dateStr: string, id: string, done: boolean): Promise<void> {
  await ref(dateStr).set(
    { done: done ? FieldValue.arrayUnion(id) : FieldValue.arrayRemove(id) },
    { merge: true },
  );
}
