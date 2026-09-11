import { it } from "@effect/vitest";
import {
	AnonymousIdentitySchema,
	HumanIdentitySchema,
	RoleName,
	ServerIdentitySchema,
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
	HumanIdentitySchema.make({
		account: { issuer: "dev", subject: "subject", displayName: "Subject" },
		roles: new Set(roles.map(RoleName)),
		globalRoles: new Set(),
	});

describe("listPermissions", () => {
	it.effect(
		"reports each namespace's declared roles intersected with the held ones",
		() =>
			Effect.gen(function* () {
				expect(
					yield* listPermissions(human("producer", "moderator", "unrelated")),
				).toEqual({
					fixture: { roles: new Set([RoleName("producer")]) },
					other: { roles: new Set([RoleName("moderator")]) },
				});
			}).pipe(provideRegistry),
	);

	it.effect("a held capability-less declared role still reports", () =>
		Effect.gen(function* () {
			const report = yield* listPermissions(human("viewer"));
			expect(report["fixture"]?.roles).toEqual(new Set([RoleName("viewer")]));
		}).pipe(provideRegistry),
	);

	it.effect("anonymous, server, and the admin tier hold no declared role", () =>
		Effect.gen(function* () {
			const identities: ReadonlyArray<Identity> = [
				AnonymousIdentitySchema.make({}),
				ServerIdentitySchema.make({}),
				HumanIdentitySchema.make({
					account: {
						issuer: "dev",
						subject: "subject",
						displayName: "Subject",
					},
					roles: new Set(),
					globalRoles: new Set(["superadmin"]),
				}),
			];
			for (const identity of identities) {
				expect(yield* listPermissions(identity)).toEqual({
					fixture: { roles: new Set() },
					other: { roles: new Set() },
				});
			}
		}).pipe(provideRegistry),
	);
});
