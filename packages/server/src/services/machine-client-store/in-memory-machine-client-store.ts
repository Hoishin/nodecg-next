import { createHash, randomBytes } from "node:crypto";

import { Effect, HashMap, Layer, Option, Redacted, Ref } from "effect";

import {
	type MachineClient,
	MachineClientStoreService,
} from "./machine-client-store.ts";

const hashToken = (token: string): Redacted.Redacted<string> =>
	Redacted.make(createHash("sha256").update(token).digest("base64url"));

const newToken = () => `ncg_${randomBytes(32).toString("base64url")}`;

export const InMemoryMachineClientStore = Layer.effect(
	MachineClientStoreService,
	Effect.gen(function* () {
		const clients = yield* Ref.make(
			HashMap.empty<Redacted.Redacted<string>, MachineClient>(),
		);

		const createApiKey = Effect.fn("MachineClientStore.createApiKey")(
			(input: { readonly displayName: string }) =>
				Ref.modify(clients, (map) => {
					const id = randomBytes(16).toString("base64url");
					const token = newToken();
					const client = { id, displayName: input.displayName };
					return [
						{ ...client, token: Redacted.make(token) },
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
				const entry = HashMap.findFirst(map, (client) => client.id === id);
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
					const entry = HashMap.findFirst(map, (client) => client.id === id);
					if (Option.isNone(entry)) {
						return [Option.none(), map];
					}
					const client = entry.value[1];
					const token = newToken();
					return [
						Option.some({ ...client, token: Redacted.make(token) }),
						HashMap.set(
							HashMap.remove(map, entry.value[0]),
							hashToken(token),
							client,
						),
					];
				}),
		);

		return { createApiKey, validateApiKey, list, revoke, refreshApiKey };
	}),
);
