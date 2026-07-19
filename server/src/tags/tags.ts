/**
 * Tag list management (T30). The set of tags the user can apply to events
 * (e.g. family-member names) is persisted in Firestore `settings/tags`
 * = { tags: [name, ...] }, seeded with a sensible default on first use.
 * Tags are applied to individual events via the event store's `tags` field.
 */
import { getDb } from "../calendar/firestore";
import { FieldValue } from "@google-cloud/firestore";

const DEFAULT_TAGS = ["Pace", "Eden", "Jamie", "Wyatt"];

function ref() {
  return getDb().collection("settings").doc("tags");
}

/** The available tag names, seeding defaults on first use. */
export async function getTags(): Promise<string[]> {
  const snap = await ref().get();
  if (snap.exists) return (snap.data()?.tags as string[]) ?? [];
  await ref().set({ tags: DEFAULT_TAGS });
  return [...DEFAULT_TAGS];
}

/** Add a tag to the available list; returns the updated list. */
export async function addTag(name: string): Promise<string[]> {
  const clean = (name ?? "").trim();
  if (!clean) throw new Error("Tag name is required.");
  await getTags(); // ensure defaults are seeded first
  await ref().set({ tags: FieldValue.arrayUnion(clean) }, { merge: true });
  return getTags();
}

/** Remove a tag from the available list; returns the updated list. */
export async function removeTag(name: string): Promise<string[]> {
  await getTags();
  await ref().set({ tags: FieldValue.arrayRemove(name) }, { merge: true });
  return getTags();
}
