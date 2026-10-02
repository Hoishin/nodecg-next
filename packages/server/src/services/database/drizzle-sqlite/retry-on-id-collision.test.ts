import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { AccountId } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { sql } from "drizzle-orm";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Crypto, Effect, Layer } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { afterEach, describe, expect, vi } from "vitest";

import { DrizzleSqliteDatabaseService } from "./drizzle-sqlite-database.ts";
import { retryOnIdCollision } from "./retry-on-id-collision.ts";
import { accounts } from "./tables.ts";

const randomBytes = vi.fn((size: number) =>
	crypto.getRandomValues(new Uint8Array(size)),
);

afterEach(() => {
	randomBytes.mockReset();
});

const test = testLayer(
	Layer.mergeAll(
		Layer.effect(
			DrizzleSqliteDatabaseService,
			DrizzleSqliteDatabaseService.make(":memory:"),
		).pipe(
			Layer.provide(
				Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, Reactivity.layer),
			),
		),
		Layer.succeed(Crypto.Crypto, Crypto.make({ randomBytes, digest: vi.fn() })),
	),
);

const insertAccount = Effect.fn(function* (displayName: string) {
	const crypto = yield* Crypto.Crypto;
	const db = yield* DrizzleSqliteDatabaseService;
	return yield* db
		.insert(accounts)
		.values({
			id: AccountId.make(yield* crypto.randomUUIDv7),
			displayName,
			createdAt: 0,
		})
		.returning()
		.pipe(Effect.head);
}, retryOnIdCollision);

describe("retryOnIdCollision", () => {
	test(
		"inserts under a fresh id when the generated id is taken",
		Effect.gen(function* () {
			const db = yield* DrizzleSqliteDatabaseService;
			randomBytes.mockReturnValueOnce(new Uint8Array(16).fill(1));
			const alice = yield* insertAccount("Alice");
			randomBytes.mockReturnValueOnce(new Uint8Array(16).fill(1));

			const bob = yield* insertAccount("Bob");

			expect(bob.id).not.toBe(alice.id);
			const rows = yield* db
				.select()
				.from(accounts)
				.orderBy(accounts.displayName);
			expect(rows).toStrictEqual([
				{ id: alice.id, displayName: "Alice", createdAt: 0 },
				{ id: bob.id, displayName: "Bob", createdAt: 0 },
			]);
		}),
	);

	test(
		"fails after two retries that each drew a taken id",
		Effect.gen(function* () {
			randomBytes.mockReturnValueOnce(new Uint8Array(16).fill(1));
			yield* insertAccount("Alice");
			randomBytes.mockReset();
			randomBytes.mockImplementation(() => new Uint8Array(16).fill(1));

			const error = yield* insertAccount("Bob").pipe(Effect.flip);

			expect(error).toBeInstanceOf(EffectDrizzleQueryError);
			expect(randomBytes).toHaveBeenCalledTimes(3);
		}),
	);

	test(
		"does not retry an insert that fails for another reason than a taken id",
		Effect.gen(function* () {
			const db = yield* DrizzleSqliteDatabaseService;
			yield* db.run(sql`drop table accounts`);

			const error = yield* insertAccount("Alice").pipe(Effect.flip);

			expect(error).toBeInstanceOf(EffectDrizzleQueryError);
			expect(randomBytes).toHaveBeenCalledOnce();
		}),
	);
});
