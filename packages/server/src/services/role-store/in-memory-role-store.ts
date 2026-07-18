import type { RoleName } from "@nodecg/internal";
import { Effect, Layer } from "effect";

import { type IdentityKey, RoleStoreService } from "./role-store.ts";

const composite = (key: IdentityKey) =>
	JSON.stringify([key.issuer, key.subject]);

export const InMemoryRoleStore = Layer.sync(RoleStoreService, () => {
	const assignments = new Map<
		string,
		{ readonly key: IdentityKey; readonly roles: Set<RoleName> }
	>();

	const get = Effect.fn("RoleStore.get")((key: IdentityKey) =>
		Effect.sync(() => new Set(assignments.get(composite(key))?.roles)),
	);

	const list = Effect.fn("RoleStore.list")(() =>
		Effect.sync(() =>
			Array.from(assignments.values(), ({ key, roles }) => ({
				key,
				roles: new Set(roles),
			})),
		),
	);

	const set = Effect.fn("RoleStore.set")(
		(key: IdentityKey, roles: ReadonlySet<RoleName>) =>
			Effect.sync(() => {
				const id = composite(key);
				if (roles.size === 0) {
					assignments.delete(id);
					return;
				}
				assignments.set(id, { key, roles: new Set(roles) });
			}),
	);

	const grant = Effect.fn("RoleStore.grant")(
		(key: IdentityKey, role: RoleName) =>
			Effect.sync(() => {
				const id = composite(key);
				const entry = assignments.get(id) ?? {
					key,
					roles: new Set<RoleName>(),
				};
				entry.roles.add(role);
				assignments.set(id, entry);
				return new Set(entry.roles);
			}),
	);

	const revoke = Effect.fn("RoleStore.revoke")(
		(key: IdentityKey, role: RoleName) =>
			Effect.sync(() => {
				const entry = assignments.get(composite(key));
				if (typeof entry === "undefined") {
					return new Set<RoleName>();
				}
				entry.roles.delete(role);
				if (entry.roles.size === 0) {
					assignments.delete(composite(key));
				}
				return new Set(entry.roles);
			}),
	);

	return { get, list, set, grant, revoke };
});
