import { createHash, randomBytes } from "node:crypto";

import { Effect, Layer, Option, Redacted } from "effect";

import { MachineClientStoreService } from "./machine-client-store.ts";

interface StoredClient {
	readonly id: string;
	readonly displayName: string;
}

const hashToken = (token: string) =>
	createHash("sha256").update(token).digest("base64url");

export const InMemoryMachineClientStore = Layer.sync(
	MachineClientStoreService,
	() => {
		const clients = new Map<string, StoredClient>();

		const createApiKey = Effect.fn("MachineClientStore.createApiKey")(
			(input: { readonly displayName: string }) =>
				Effect.sync(() => {
					const id = randomBytes(16).toString("base64url");
					const token = `ncg_${randomBytes(32).toString("base64url")}`;
					clients.set(hashToken(token), { id, displayName: input.displayName });
					return {
						id,
						displayName: input.displayName,
						token: Redacted.make(token),
					};
				}),
		);

		const validateApiKey = Effect.fn("MachineClientStore.validateApiKey")(
			(token: string) =>
				Effect.sync(() => Option.fromNullable(clients.get(hashToken(token)))),
		);

		return { createApiKey, validateApiKey };
	},
);
