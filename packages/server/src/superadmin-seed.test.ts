import { RESERVED_ROLE } from "@nodecg/internal";
import { testEffect } from "@nodecg/internal/test-utils";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";

import { RoleStoreService } from "./services/role-store/role-store.ts";
import { seededRoleStore } from "./superadmin-seed.ts";

describe("seededRoleStore", () => {
	test(
		"grants superadmin to each seeded identity and nothing to others",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				expect(yield* roles.get({ issuer: "dev", subject: "root" })).toEqual(
					new Set([RESERVED_ROLE.superadmin]),
				);
				expect(yield* roles.get({ issuer: "dev", subject: "other" })).toEqual(
					new Set(),
				);
			}).pipe(
				Effect.provide(seededRoleStore([{ issuer: "dev", subject: "root" }])),
			),
		),
	);

	test(
		"seeds nothing for an empty list",
		testEffect(
			Effect.gen(function* () {
				const roles = yield* RoleStoreService;
				expect(yield* roles.get({ issuer: "dev", subject: "root" })).toEqual(
					new Set(),
				);
			}).pipe(Effect.provide(seededRoleStore([]))),
		),
	);
});
