import { randomBytes } from "node:crypto";

import { Clock, Duration, Effect, Layer, Option } from "effect";

import { type AuthStash, StashStoreService } from "./stash-store.ts";

const ttlMillis = Duration.toMillis(Duration.minutes(10));

interface StashEntry {
	readonly stash: AuthStash;
	readonly expiresAt: number;
}

export const InMemoryStashStore = Layer.sync(StashStoreService, () => {
	const stashes = new Map<string, StashEntry>();

	const create = Effect.fn("StashStore.create")(function* (stash: AuthStash) {
		const now = yield* Clock.currentTimeMillis;
		const id = randomBytes(32).toString("base64url");
		stashes.set(id, { stash, expiresAt: now + ttlMillis });
		return id;
	});

	const lookup = Effect.fn("StashStore.lookup")(function* (id: string) {
		const entry = stashes.get(id);
		if (typeof entry === "undefined") {
			return Option.none();
		}
		const now = yield* Clock.currentTimeMillis;
		if (entry.expiresAt <= now) {
			stashes.delete(id);
			return Option.none();
		}
		return Option.some(entry.stash);
	});

	const revoke = Effect.fn("StashStore.revoke")((id: string) =>
		Effect.sync(() => {
			stashes.delete(id);
		}),
	);

	return { create, lookup, revoke };
});
