import { createHash, randomBytes } from "node:crypto";

import type { RoleName } from "@nodecg/internal";
import { Effect, HashMap, Layer, Option, Redacted, Ref } from "effect";

import {
	type MachineClient,
	MachineClientStoreService,
} from "./machine-client-store.ts";

type Clients = HashMap.HashMap<Redacted.Redacted<string>, MachineClient>;

const hashToken = (token: string): Redacted.Redacted<string> =>
	Redacted.make(createHash("sha256").update(token).digest("base64url"));

const newToken = () => `ncg_${randomBytes(32).toString("base64url")}`;

const findById = (map: Clients, id: string) =>
	HashMap.findFirst(map, (client) => client.id === id);

export const InMemoryMachineClientStore = Layer.effect(
	MachineClientStoreService,
	Effect.gen(function* () {
		const clients = yield* Ref.make<Clients>(HashMap.empty());

		const createApiKey = Effect.fn("MachineClientStore.createApiKey")(
			(input: { readonly displayName: string }) =>
				Ref.modify(clients, (map) => {
					const id = randomBytes(16).toString("base64url");
					const token = newToken();
					const client: MachineClient = {
						id,
						displayName: input.displayName,
						roles: new Set(),
					};
					return [
						{ id, displayName: input.displayName, token: Redacted.make(token) },
						HashMap.set(map, hashToken(token), client),
					];
				}),
		);

		const validateApiKey = Effect.fn("MachineClientStore.validateApiKey")(
			(token: string) =>
				Ref.get(clients).pipe(
					Effect.map((map) => HashMap.get(map, hashToken(token))),
				),
		);

		const list = Effect.fn("MachineClientStore.list")(() =>
			Ref.get(clients).pipe(
				Effect.map((map) => Array.from(HashMap.values(map))),
			),
		);

		const revoke = Effect.fn("MachineClientStore.revoke")((id: string) =>
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

		const refreshApiKey = Effect.fn("MachineClientStore.refreshApiKey")(
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

		const grantRole = Effect.fn("MachineClientStore.grantRole")(
			(id: string, role: RoleName) =>
				Ref.modify(clients, (map) => {
					const entry = findById(map, id);
					if (Option.isNone(entry)) {
						return [Option.none(), map];
					}
					const [key, client] = entry.value;
					const roles = new Set(client.roles).add(role);
					return [
						Option.some(roles),
						HashMap.set(map, key, { ...client, roles }),
					];
				}),
		);

		const revokeRole = Effect.fn("MachineClientStore.revokeRole")(
			(id: string, role: RoleName) =>
				Ref.modify(clients, (map) => {
					const entry = findById(map, id);
					if (Option.isNone(entry)) {
						return [Option.none(), map];
					}
					const [key, client] = entry.value;
					const roles = new Set(client.roles);
					roles.delete(role);
					return [
						Option.some(roles),
						HashMap.set(map, key, { ...client, roles }),
					];
				}),
		);

		return {
			createApiKey,
			validateApiKey,
			list,
			revoke,
			refreshApiKey,
			grantRole,
			revokeRole,
		};
	}),
);
