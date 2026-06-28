import type { RoleName } from "@nodecg/internal";
import { Effect, Layer } from "effect";

import { type IdentityKey, RoleStoreService } from "./role-store.ts";

const composite = (key: IdentityKey) =>
	JSON.stringify([key.issuer, key.subject]);

export const InMemoryRoleStore = Layer.sync(RoleStoreService, () => {
	const assignments = new Map<string, Set<RoleName>>();

	const get = Effect.fn("RoleStore.get")((key: IdentityKey) =>
		Effect.sync(() => new Set(assignments.get(composite(key)))),
	);

	const grant = Effect.fn("RoleStore.grant")(
		(key: IdentityKey, role: RoleName) =>
			Effect.sync(() => {
				const id = composite(key);
				const roles = assignments.get(id) ?? new Set<RoleName>();
				roles.add(role);
				assignments.set(id, roles);
				return new Set(roles);
			}),
	);

	const revoke = Effect.fn("RoleStore.revoke")(
		(key: IdentityKey, role: RoleName) =>
			Effect.sync(() => {
				const id = composite(key);
				const roles = assignments.get(id);
				if (typeof roles === "undefined") {
					return new Set<RoleName>();
				}
				roles.delete(role);
				if (roles.size === 0) {
					assignments.delete(id);
				}
				return new Set(roles);
			}),
	);

	return { get, grant, revoke };
});
