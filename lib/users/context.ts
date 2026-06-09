// lib/users/context.ts — request-scoped current user via AsyncLocalStorage.
// Phase 2's withUser() establishes the context per request; lib code reads it
// through settings.getEffectiveSettings(). Type-only import of UserProfile keeps
// this module free of a runtime dependency on the store (no import cycle).
import { AsyncLocalStorage } from "node:async_hooks";
import type { UserProfile } from "./store";

export type UserContext = UserProfile;

const als = new AsyncLocalStorage<UserContext>();

/** Run `fn` with `ctx` as the current user for the duration (incl. awaits). */
export function runWithUser<T>(ctx: UserContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** The current request's user, or null outside any runWithUser scope. */
export function getCurrentUser(): UserContext | null {
  return als.getStore() ?? null;
}
