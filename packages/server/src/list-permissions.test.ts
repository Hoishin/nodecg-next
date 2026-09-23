import { it } from "@effect/vitest";
import {
	AnonymousIdentitySchema,
	HumanIdentity,
	type Role,
	RoleName,
	ServerIdentity,
	type Identity,
} from "@nodecg-next/internal";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
	FieldRegistryService,
	type RegisteredNamespace,
} from "./field-registry.ts";
import { listPermissions } from "./list-permissions.ts";

const registered = (
	namespace: string,
	declaredRoles: ReadonlySet<RoleName>,
): RegisteredNamespace => ({
	namespace,
	declaredRoles,
	fields: { replicant: {}, computed: {}, topic: {}, rpc: {} },
});

const provideRegistry = Effect.provide(
	FieldRegistryService.layer([
		registered("fixture", new Set([RoleName("producer"), RoleName("viewer")])),
		registered("other", new Set([RoleName("moderator"), RoleName("producer")])),
	]),
);

const human = (...roles: ReadonlyArray<Role>) =>
	HumanIdentity.make({
		account: { issuer: "dev", subject: "subject", displayName: "Subject" },
		roles,
		globalRoles: [],
	});

describe("listPermissions", () => {
	it.effect(
		"reports each namespace's declared roles intersected with the ones held there",
		() =>
			Effect.gen(function* () {
				expect(
					yield* listPermissions(
						human(
							{ namespace: "fixture", name: RoleName("producer") },
							{ namespace: "fixture", name: RoleName("unrelated") },
							{ namespace: "other", name: RoleName("moderator") },
						),
					),
				).toEqual({
					fixture: { roles: [RoleName("producer")] },
					other: { roles: [RoleName("moderator")] },
				});
			}).pipe(provideRegistry),
	);

	it.effect(
		"does not report a role held in one namespace under another declaring it",
		() =>
			Effect.gen(function* () {
				const report = yield* listPermissions(
					human({ namespace: "fixture", name: RoleName("producer") }),
				);
				expect(report["other"]?.roles).toEqual([]);
			}).pipe(provideRegistry),
	);

	it.effect("a held capability-less declared role still reports", () =>
		Effect.gen(function* () {
			const report = yield* listPermissions(
				human({ namespace: "fixture", name: RoleName("viewer") }),
			);
			expect(report["fixture"]?.roles).toEqual([RoleName("viewer")]);
		}).pipe(provideRegistry),
	);

	it.effect("anonymous, server, and the admin tier hold no declared role", () =>
		Effect.gen(function* () {
			const identities: ReadonlyArray<Identity> = [
				AnonymousIdentitySchema.make({}),
				ServerIdentity.make({}),
				HumanIdentity.make({
					account: {
						issuer: "dev",
						subject: "subject",
						displayName: "Subject",
					},
					roles: [],
					globalRoles: ["superadmin"],
				}),
			];
			for (const identity of identities) {
				expect(yield* listPermissions(identity)).toEqual({
					fixture: { roles: [] },
					other: { roles: [] },
				});
			}
		}).pipe(provideRegistry),
	);
});
