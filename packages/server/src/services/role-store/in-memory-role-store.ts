import type { GlobalRoleName, Login, RoleName } from "@nodecg-next/internal";
import { Array, Effect, Layer, MutableHashMap, Option } from "effect";

import { type RoleGrants, RoleStoreService } from "./role-store.ts";

const unassigned: RoleGrants = { roles: [], globalRoles: [] };

export const InMemoryRoleStore = Layer.sync(RoleStoreService, () => {
	const assignments = MutableHashMap.empty<Login, RoleGrants>();

	const current = (key: Login): RoleGrants =>
		MutableHashMap.get(assignments, key).pipe(
			Option.getOrElse(() => unassigned),
		);

	const get = Effect.fn("RoleStore.get")((key: Login) =>
		Effect.sync(() => current(key)),
	);

	const list = Effect.sync(() =>
		Array.fromIterable(assignments).map(([key, { roles, globalRoles }]) => ({
			key,
			roles,
			globalRoles,
		})),
	);

	const setRoles = Effect.fn("RoleStore.setRoles")(
		(key: Login, roles: ReadonlyArray<RoleName>) =>
			Effect.sync(() => {
				MutableHashMap.set(assignments, key, {
					roles: Array.dedupe(roles),
					globalRoles: current(key).globalRoles,
				});
			}),
	);

	const grantRole = Effect.fn("RoleStore.grantRole")(
		(key: Login, role: RoleName) =>
			Effect.sync(() => {
				const grants = current(key);
				const roles = Array.union(grants.roles, [role]);
				MutableHashMap.set(assignments, key, {
					roles,
					globalRoles: grants.globalRoles,
				});
				return roles;
			}),
	);

	const revokeRole = Effect.fn("RoleStore.revokeRole")(
		(key: Login, role: RoleName) =>
			Effect.sync(() => {
				const existing = MutableHashMap.get(assignments, key);
				if (Option.isNone(existing)) {
					return [];
				}
				const roles = Array.difference(existing.value.roles, [role]);
				MutableHashMap.set(assignments, key, {
					roles,
					globalRoles: existing.value.globalRoles,
				});
				return roles;
			}),
	);

	const setGlobalRoles = Effect.fn("RoleStore.setGlobalRoles")(
		(key: Login, globalRoles: ReadonlyArray<GlobalRoleName>) =>
			Effect.sync(() => {
				MutableHashMap.set(assignments, key, {
					roles: current(key).roles,
					globalRoles: Array.dedupe(globalRoles),
				});
			}),
	);

	const grantGlobalRole = Effect.fn("RoleStore.grantGlobalRole")(
		(key: Login, role: GlobalRoleName) =>
			Effect.sync(() => {
				const grants = current(key);
				const globalRoles = Array.union(grants.globalRoles, [role]);
				MutableHashMap.set(assignments, key, {
					roles: grants.roles,
					globalRoles,
				});
				return globalRoles;
			}),
	);

	const revokeGlobalRole = Effect.fn("RoleStore.revokeGlobalRole")(
		(key: Login, role: GlobalRoleName) =>
			Effect.sync(() => {
				const existing = MutableHashMap.get(assignments, key);
				if (Option.isNone(existing)) {
					return [];
				}
				const globalRoles = Array.difference(existing.value.globalRoles, [
					role,
				]);
				MutableHashMap.set(assignments, key, {
					roles: existing.value.roles,
					globalRoles,
				});
				return globalRoles;
			}),
	);

	return {
		get,
		list,
		setRoles,
		grantRole,
		revokeRole,
		setGlobalRoles,
		grantGlobalRole,
		revokeGlobalRole,
	};
});
