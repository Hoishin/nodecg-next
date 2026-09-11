import type { GlobalRoleName, RoleName } from "@nodecg-next/internal";
import { Effect, Layer, MutableHashMap, Option } from "effect";

import { type IdentityKey, RoleStoreService } from "./role-store.ts";

interface Entry {
	readonly key: IdentityKey;
	readonly roles: Set<RoleName>;
	readonly globalRoles: Set<GlobalRoleName>;
}

export const InMemoryRoleStore = Layer.sync(RoleStoreService, () => {
	const assignments = MutableHashMap.empty<IdentityKey, Entry>();

	const getOrCreate = (key: IdentityKey): Entry => {
		const existing = MutableHashMap.get(assignments, key);
		if (Option.isSome(existing)) {
			return existing.value;
		}
		const entry: Entry = { key, roles: new Set(), globalRoles: new Set() };
		MutableHashMap.set(assignments, key, entry);
		return entry;
	};

	const get = Effect.fn("RoleStore.get")((key: IdentityKey) =>
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

	const set = Effect.fn("RoleStore.set")(
		(key: IdentityKey, roles: ReadonlySet<RoleName>) =>
			Effect.sync(() => {
				const entry = getOrCreate(key);
				entry.roles.clear();
				for (const role of roles) {
					entry.roles.add(role);
				}
			}),
	);

	const grant = Effect.fn("RoleStore.grant")(
		(key: IdentityKey, role: RoleName) =>
			Effect.sync(() => {
				const entry = getOrCreate(key);
				entry.roles.add(role);
				return new Set(entry.roles);
			}),
	);

	const revoke = Effect.fn("RoleStore.revoke")(
		(key: IdentityKey, role: RoleName) =>
			Effect.sync(() => {
				const entry = MutableHashMap.get(assignments, key);
				if (Option.isNone(entry)) {
					return new Set<RoleName>();
				}
				entry.value.roles.delete(role);
				return new Set(entry.value.roles);
			}),
	);

	const setGlobal = Effect.fn("RoleStore.setGlobal")(
		(key: IdentityKey, globalRoles: ReadonlySet<GlobalRoleName>) =>
			Effect.sync(() => {
				const entry = getOrCreate(key);
				entry.globalRoles.clear();
				for (const role of globalRoles) {
					entry.globalRoles.add(role);
				}
			}),
	);

	const grantGlobal = Effect.fn("RoleStore.grantGlobal")(
		(key: IdentityKey, role: GlobalRoleName) =>
			Effect.sync(() => {
				const entry = getOrCreate(key);
				entry.globalRoles.add(role);
				return new Set(entry.globalRoles);
			}),
	);

	const revokeGlobal = Effect.fn("RoleStore.revokeGlobal")(
		(key: IdentityKey, role: GlobalRoleName) =>
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
		set,
		grant,
		revoke,
		setGlobal,
		grantGlobal,
		revokeGlobal,
	};
});
