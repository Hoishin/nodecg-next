import { randomUUID } from "node:crypto";

import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { testLayer } from "@nodecg-next/test-utils";
import { sql } from "drizzle-orm";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import { Effect, Layer } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { afterEach, describe, expect, vi } from "vitest";

import { DrizzleSqliteDatabaseService } from "./drizzle-sqlite-database.ts";
import { retryOnIdCollision } from "./retry-on-id-collision.ts";
import { accounts } from "./tables.ts";

const test = testLayer(
	Layer.effect(
		DrizzleSqliteDatabaseService,
		DrizzleSqliteDatabaseService.make(":memory:"),
	).pipe(
		Layer.provide(
			Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, Reactivity.layer),
		),
	),
);

vi.mock(import("node:crypto"), { spy: true });

afterEach(() => {
	vi.mocked(randomUUID).mockReset();
});

const insertAccount = Effect.fn(function* (displayName: string) {
	const db = yield* DrizzleSqliteDatabaseService;
	return yield* db
		.insert(accounts)
		.values({ displayName, createdAt: 0 })
		.returning()
		.pipe(retryOnIdCollision);
});

describe("retryOnIdCollision", () => {
	test(
		"inserts under a fresh id when the generated id is taken",
		Effect.gen(function* () {
			const db = yield* DrizzleSqliteDatabaseService;
			const takenId = randomUUID();
			vi.mocked(randomUUID).mockReturnValueOnce(takenId);
			yield* insertAccount("Alice");
			vi.mocked(randomUUID).mockReturnValueOnce(takenId);

			const [bob] = yield* insertAccount("Bob");

			expect(bob?.id).not.toBe(takenId);
			expect(
				yield* db.select().from(accounts).orderBy(accounts.displayName),
			).toStrictEqual([
				{ id: takenId, displayName: "Alice", createdAt: 0 },
				{ id: bob?.id, displayName: "Bob", createdAt: 0 },
			]);
		}),
	);

	test(
		"fails after two retries that each drew a taken id",
		Effect.gen(function* () {
			const takenId = randomUUID();
			vi.mocked(randomUUID).mockReturnValueOnce(takenId);
			yield* insertAccount("Alice");
			vi.mocked(randomUUID).mockReset();
			vi.mocked(randomUUID).mockReturnValue(takenId);

			const error = yield* insertAccount("Bob").pipe(Effect.flip);

			expect(error).toBeInstanceOf(EffectDrizzleQueryError);
			expect(randomUUID).toHaveBeenCalledTimes(3);
		}),
	);

	test(
		"does not retry an insert that fails for another reason than a taken id",
		Effect.gen(function* () {
			const db = yield* DrizzleSqliteDatabaseService;
			yield* db.run(sql`drop table accounts`);

			const error = yield* insertAccount("Alice").pipe(Effect.flip);

			expect(error).toBeInstanceOf(EffectDrizzleQueryError);
			expect(randomUUID).toHaveBeenCalledOnce();
		}),
	);
});
