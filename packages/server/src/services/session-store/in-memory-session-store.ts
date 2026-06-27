import { randomBytes } from "node:crypto";

import type { HumanIdentity } from "@nodecg/internal";
import { Clock, Duration, Effect, Layer, Option } from "effect";

import { config } from "../../server-config.ts";
import { SessionStoreService } from "./session-store.ts";

interface SessionEntry {
	readonly identity: HumanIdentity;
	expiresAt: number;
}

export const InMemorySessionStore = Layer.effect(
	SessionStoreService,
	Effect.gen(function* () {
		const ttlMillis = Duration.toMillis(yield* config.sessionTtl);
		const sessions = new Map<string, SessionEntry>();

		const create = Effect.fn("SessionStore.create")(function* (
			identity: HumanIdentity,
		) {
			const now = yield* Clock.currentTimeMillis;
			const sessionId = randomBytes(32).toString("base64url");
			sessions.set(sessionId, { identity, expiresAt: now + ttlMillis });
			return sessionId;
		});

		const lookup = Effect.fn("SessionStore.lookup")(function* (
			sessionId: string,
		) {
			const entry = sessions.get(sessionId);
			if (typeof entry === "undefined") {
				return Option.none();
			}
			const now = yield* Clock.currentTimeMillis;
			if (entry.expiresAt <= now) {
				sessions.delete(sessionId);
				return Option.none();
			}
			return Option.some(entry.identity);
		});

		const refreshTTL = Effect.fn("SessionStore.refreshTTL")(function* (
			sessionId: string,
		) {
			const entry = sessions.get(sessionId);
			if (typeof entry === "undefined") {
				return;
			}
			const now = yield* Clock.currentTimeMillis;
			if (entry.expiresAt > now) {
				entry.expiresAt = now + ttlMillis;
			}
		});

		const revoke = Effect.fn("SessionStore.revoke")((sessionId: string) =>
			Effect.sync(() => {
				sessions.delete(sessionId);
			}),
		);

		return { create, lookup, refreshTTL, revoke };
	}),
);
