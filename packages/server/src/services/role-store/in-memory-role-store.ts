import type { GlobalRoleName, Login, RoleName } from "@nodecg-next/internal";
import { Effect, Layer, MutableHashMap, Option } from "effect";

import { RoleStoreService } from "./role-store.ts";

interface Entry {
	readonly key: Login;
	readonly roles: Set<RoleName>;
	readonly globalRoles: Set<GlobalRoleName>;
}

export const InMemoryRoleStore = Layer.sync(RoleStoreService, () => {
	const assignments = MutableHashMap.empty<Login, Entry>();

	const getOrCreate = (key: Login): Entry => {
		const existing = MutableHashMap.get(assignments, key);
		if (Option.isSome(existing)) {
			return existing.value;
		}
		const entry: Entry = { key, roles: new Set(), globalRoles: new Set() };
		MutableHashMap.set(assignments, key, entry);
		return entry;
	};

	const get = Effect.fn("RoleStore.get")((key: Login) =>
		Effect.sync(() =>
			Option.match(MutableHashMap.get(assignments, key), {
				onNone: () => ({
					roles: new Set<RoleName>(),
					globalRoles: new Set<GlobalRoleName>(),
				}),
				onSome: ({ roles, globalRoles }) => ({
					roles: new Set(roles),
					globalRoles: new Set(globalRoles),
				}),
			}),
		),
	);

	const list = Effect.sync(() =>
		Array.from(
			MutableHashMap.values(assignments),
			({ key, roles, globalRoles }) => ({
				key,
				roles: new Set(roles),
				globalRoles: new Set(globalRoles),
			}),
		),
	);

	const setRoles = Effect.fn("RoleStore.setRoles")(
		(key: Login, roles: ReadonlySet<RoleName>) =>
			Effect.sync(() => {
				const entry = getOrCreate(key);
				entry.roles.clear();
				for (const role of roles) {
					entry.roles.add(role);
				}
			}),
	);

	const grantRole = Effect.fn("RoleStore.grantRole")(
		(key: Login, role: RoleName) =>
			Effect.sync(() => {
				const entry = getOrCreate(key);
				entry.roles.add(role);
				return new Set(entry.roles);
			}),
	);

	const revokeRole = Effect.fn("RoleStore.revokeRole")(
		(key: Login, role: RoleName) =>
			Effect.sync(() => {
				const entry = MutableHashMap.get(assignments, key);
				if (Option.isNone(entry)) {
					return new Set<RoleName>();
				}
				entry.value.roles.delete(role);
				return new Set(entry.value.roles);
			}),
	);

	const setGlobalRoles = Effect.fn("RoleStore.setGlobalRoles")(
		(key: Login, globalRoles: ReadonlySet<GlobalRoleName>) =>
			Effect.sync(() => {
				const entry = getOrCreate(key);
				entry.globalRoles.clear();
				for (const role of globalRoles) {
					entry.globalRoles.add(role);
				}
			}),
	);

	const grantGlobalRole = Effect.fn("RoleStore.grantGlobalRole")(
		(key: Login, role: GlobalRoleName) =>
			Effect.sync(() => {
				const entry = getOrCreate(key);
				entry.globalRoles.add(role);
				return new Set(entry.globalRoles);
			}),
	);

	const revokeGlobalRole = Effect.fn("RoleStore.revokeGlobalRole")(
		(key: Login, role: GlobalRoleName) =>
			Effect.sync(() => {
				const entry = MutableHashMap.get(assignments, key);
				if (Option.isNone(entry)) {
					return new Set<GlobalRoleName>();
				}
				entry.value.globalRoles.delete(role);
				return new Set(entry.value.globalRoles);
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
