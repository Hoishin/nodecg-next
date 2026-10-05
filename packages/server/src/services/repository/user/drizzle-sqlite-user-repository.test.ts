import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node";
import { RoleName } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, HashMap, HashSet, Layer } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { describe, expect } from "vitest";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { AuthenticationRepositoryService } from "../authentication/authentication-repository.ts";
import { DrizzleSqliteAuthenticationRepository } from "../authentication/drizzle-sqlite-authentication-repository.ts";
import { DrizzleSqliteRoleRepository } from "../role/drizzle-sqlite-role-repository.ts";
import { RoleRepositoryService } from "../role/role-repository.ts";
import { DrizzleSqliteUserRepository } from "./drizzle-sqlite-user-repository.ts";
import { UserRepositoryService } from "./user-repository.ts";

const test = testLayer(
	Layer.mergeAll(
		DrizzleSqliteUserRepository,
		DrizzleSqliteAuthenticationRepository,
		DrizzleSqliteRoleRepository,
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

describe("listAll", () => {
	test(
		"lists each user with its account, authentications and roles",
		Effect.gen(function* () {
			const repository = yield* UserRepositoryService;
			const authentications = yield* AuthenticationRepositoryService;
			const roles = yield* RoleRepositoryService;
			const viewer = { namespace: "show", name: RoleName("viewer") };

			const alice = yield* authentications.findOrCreateAuthentication(
				{ issuer: "dev", subject: "alice" },
				"Alice",
			);
			yield* roles.grantRoles(
				HashMap.make([alice.accountId, HashSet.make(viewer)]),
			);
			yield* roles.grantGlobalRole(alice.accountId, "admin");

			const bob = yield* authentications.findOrCreateAuthentication(
				{ issuer: "dev", subject: "bob" },
				"Bob",
			);

			const listed = yield* repository.listAll();
			expect(listed).to.have.deep.members([
				{
					id: alice.userId,
					accountId: alice.accountId,
					displayName: "Alice",
					authentications: [{ issuer: "dev", subject: "alice" }],
					roles: [viewer],
					globalRoles: ["admin"],
				},
				{
					id: bob.userId,
					accountId: bob.accountId,
					displayName: "Bob",
					authentications: [{ issuer: "dev", subject: "bob" }],
					roles: [],
					globalRoles: [],
				},
			]);
		}),
	);
});
