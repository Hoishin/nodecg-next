import { createHash, randomBytes } from "node:crypto";

import type { GlobalRoleName, Role } from "@nodecg-next/internal";
import { Array, Effect, HashMap, Layer, Option, Redacted, Ref } from "effect";

import {
	type ServiceAccount,
	ServiceAccountStoreService,
} from "./service-account-store.ts";

type Clients = HashMap.HashMap<Redacted.Redacted<string>, ServiceAccount>;

const hashToken = (token: string): Redacted.Redacted<string> =>
	Redacted.make(createHash("sha256").update(token).digest("base64url"));

const newToken = () => `ncg_${randomBytes(32).toString("base64url")}`;

const findById = (map: Clients, id: string) =>
	HashMap.findFirst(map, (client) => client.id === id);

export const InMemoryServiceAccountStore = Layer.effect(
	ServiceAccountStoreService,
	Effect.gen(function* () {
		const clients = yield* Ref.make<Clients>(HashMap.empty());

		const createApiKey = Effect.fn("ServiceAccountStore.createApiKey")(
			(input: { readonly displayName: string }) =>
				Ref.modify(clients, (map) => {
					const id = randomBytes(16).toString("base64url");
					const token = newToken();
					const client: ServiceAccount = {
						id,
						displayName: input.displayName,
						roles: [],
						globalRoles: [],
					};
					return [
						{ id, displayName: input.displayName, token: Redacted.make(token) },
						HashMap.set(map, hashToken(token), client),
					];
				}),
		);

		const validateApiKey = Effect.fn("ServiceAccountStore.validateApiKey")(
			(token: string) =>
				Ref.get(clients).pipe(
					Effect.map((map) => HashMap.get(map, hashToken(token))),
				),
		);

		const list = Ref.get(clients).pipe(
			Effect.map((map) => Array.fromIterable(HashMap.values(map))),
		);

		const revoke = Effect.fn("ServiceAccountStore.revoke")((id: string) =>
			Ref.modify(clients, (map) => {
				const entry = findById(map, id);
				if (Option.isNone(entry)) {
					return [Option.none(), map];
				}
				return [
					Option.some(entry.value[1]),
					HashMap.remove(map, entry.value[0]),
				];
			}),
		);

		const refreshApiKey = Effect.fn("ServiceAccountStore.refreshApiKey")(
			(id: string) =>
				Ref.modify(clients, (map) => {
					const entry = findById(map, id);
					if (Option.isNone(entry)) {
						return [Option.none(), map];
					}
					const client = entry.value[1];
					const token = newToken();
					return [
						Option.some({
							id: client.id,
							displayName: client.displayName,
							token: Redacted.make(token),
						}),
						HashMap.set(
							HashMap.remove(map, entry.value[0]),
							hashToken(token),
							client,
						),
					];
				}),
		);

		const setRoles = Effect.fn("ServiceAccountStore.setRoles")(
			(id: string, roles: ReadonlyArray<Role>) =>
				Ref.modify(clients, (map) => {
					const entry = findById(map, id);
					if (Option.isNone(entry)) {
						return [Option.none(), map];
					}
					const [key, client] = entry.value;
					const next = { ...client, roles: Array.dedupe(roles) };
					return [Option.some(next.roles), HashMap.set(map, key, next)];
				}),
		);

		const grantRole = Effect.fn("ServiceAccountStore.grantRole")(
			(id: string, role: Role) =>
				Ref.modify(clients, (map) => {
					const entry = findById(map, id);
					if (Option.isNone(entry)) {
						return [Option.none(), map];
					}
					const [key, client] = entry.value;
					const roles = Array.union(client.roles, [role]);
					return [
						Option.some(roles),
						HashMap.set(map, key, { ...client, roles }),
					];
				}),
		);

		const revokeRole = Effect.fn("ServiceAccountStore.revokeRole")(
			(id: string, role: Role) =>
				Ref.modify(clients, (map) => {
					const entry = findById(map, id);
					if (Option.isNone(entry)) {
						return [Option.none(), map];
					}
					const [key, client] = entry.value;
					const roles = Array.difference(client.roles, [role]);
					return [
						Option.some(roles),
						HashMap.set(map, key, { ...client, roles }),
					];
				}),
		);

		const setGlobalRoles = Effect.fn("ServiceAccountStore.setGlobalRoles")(
			(id: string, globalRoles: ReadonlyArray<GlobalRoleName>) =>
				Ref.modify(clients, (map) => {
					const entry = findById(map, id);
					if (Option.isNone(entry)) {
						return [Option.none(), map];
					}
					const [key, client] = entry.value;
					const next = { ...client, globalRoles: Array.dedupe(globalRoles) };
					return [Option.some(next.globalRoles), HashMap.set(map, key, next)];
				}),
		);

		const grantGlobalRole = Effect.fn("ServiceAccountStore.grantGlobalRole")(
			(id: string, role: GlobalRoleName) =>
				Ref.modify(clients, (map) => {
					const entry = findById(map, id);
					if (Option.isNone(entry)) {
						return [Option.none(), map];
					}
					const [key, client] = entry.value;
					const globalRoles = Array.union(client.globalRoles, [role]);
					return [
						Option.some(globalRoles),
						HashMap.set(map, key, { ...client, globalRoles }),
					];
				}),
		);

		const revokeGlobalRole = Effect.fn("ServiceAccountStore.revokeGlobalRole")(
			(id: string, role: GlobalRoleName) =>
				Ref.modify(clients, (map) => {
					const entry = findById(map, id);
					if (Option.isNone(entry)) {
						return [Option.none(), map];
					}
					const [key, client] = entry.value;
					const globalRoles = Array.difference(client.globalRoles, [role]);
					return [
						Option.some(globalRoles),
						HashMap.set(map, key, { ...client, globalRoles }),
					];
				}),
		);

		return {
			createApiKey,
			validateApiKey,
			list,
			revoke,
			refreshApiKey,
			setRoles,
			grantRole,
			revokeRole,
			setGlobalRoles,
			grantGlobalRole,
			revokeGlobalRole,
		};
	}),
);
