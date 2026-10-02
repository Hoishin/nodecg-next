import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { testLayer } from "@nodecg-next/test-utils";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { assert, describe, expect } from "vitest";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { accounts } from "../../database/drizzle-sqlite/tables.ts";
import { AuthenticationRepositoryService } from "../authentication/authentication-repository.ts";
import { DrizzleSqliteAuthenticationRepository } from "../authentication/drizzle-sqlite-authentication-repository.ts";
import { BackendError } from "../repository-errors.ts";
import { AccountRepositoryService } from "./account-repository.ts";
import { DrizzleSqliteAccountRepository } from "./drizzle-sqlite-account-repository.ts";

const test = testLayer(
	Layer.mergeAll(
		DrizzleSqliteAccountRepository,
		DrizzleSqliteAuthenticationRepository,
	).pipe(
		Layer.provideMerge(
			Layer.effect(
				DrizzleSqliteDatabaseService,
				DrizzleSqliteDatabaseService.make(":memory:"),
			),
		),
		Layer.provide(
			Layer.mergeAll(
				NodeFileSystem.layer,
				NodePath.layer,
				NodeCrypto.layer,
				Reactivity.layer,
			),
		),
	),
);

describe("resolveByAuthentication", () => {
	test(
		"resolves an authentication to the account its first login created",
		Effect.gen(function* () {
			const repository = yield* AccountRepositoryService;
			const authentications = yield* AuthenticationRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			yield* authentications.findOrCreateAuthentication(
				{ issuer: "dev", subject: "bob" },
				"Bob",
			);
			yield* authentications.findOrCreateAuthentication(
				{ issuer: "dev", subject: "alice" },
				"Alice",
			);
			const alice = yield* db
				.select({ id: accounts.id })
				.from(accounts)
				.where(eq(accounts.displayName, "Alice"))
				.pipe(Effect.head);

			expect(
				yield* repository.resolveByAuthentication({
					issuer: "dev",
					subject: "alice",
				}),
			).toStrictEqual(Option.some(alice.id));
		}),
	);

	test(
		"treats an authentication without an account as absent",
		Effect.gen(function* () {
			const repository = yield* AccountRepositoryService;
			const authentications = yield* AuthenticationRepositoryService;
			yield* authentications.findOrCreateAuthentication(
				{ issuer: "dev", subject: "alice" },
				"Alice",
			);

			expect(
				yield* repository.resolveByAuthentication({
					issuer: "other",
					subject: "alice",
				}),
			).toStrictEqual(Option.none());
		}),
	);

	test(
		"fails with a backend error when the query fails",
		Effect.gen(function* () {
			const repository = yield* AccountRepositoryService;
			const db = yield* DrizzleSqliteDatabaseService;
			yield* db.run(sql`drop table authentications`);

			const error = yield* repository
				.resolveByAuthentication({ issuer: "dev", subject: "alice" })
				.pipe(Effect.flip);

			assert(Schema.is(BackendError)(error));
		}),
	);
});
