import { it } from "@effect/vitest";
import {
	AnonymousIdentitySchema,
	HumanIdentity,
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
		registered("other", new Set([RoleName("moderator")])),
	]),
);

const human = (...roles: ReadonlyArray<string>) =>
	HumanIdentity.make({
		account: { issuer: "dev", subject: "subject", displayName: "Subject" },
		roles: roles.map(RoleName),
		globalRoles: [],
	});

describe("listPermissions", () => {
	it.effect(
		"reports each namespace's declared roles intersected with the held ones",
		() =>
			Effect.gen(function* () {
				expect(
					yield* listPermissions(human("producer", "moderator", "unrelated")),
				).toEqual({
					fixture: { roles: [RoleName("producer")] },
					other: { roles: [RoleName("moderator")] },
				});
			}).pipe(provideRegistry),
	);

	it.effect("a held capability-less declared role still reports", () =>
		Effect.gen(function* () {
			const report = yield* listPermissions(human("viewer"));
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
