import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { StateDefinition, StateManifest } from "@nodecg/core";
import { mapEffectFnToNeverthrow, mapValues } from "@nodecg/internal";
import { Data, Effect, type HKT, Match } from "effect";
import { type Result } from "neverthrow";

import { runtime } from "./runtime";

export class GetStateError extends Data.TaggedError("GetStateError")<{
	readonly namespace: string;
	readonly name: string;
	readonly cause: string;
}> {
	override get message() {
		return `Failed to get state "${this.name}" in "${this.namespace}": ${this.cause}`;
	}
}

export class UpdateStateError extends Data.TaggedError("UpdateStateError")<{
	readonly namespace: string;
	readonly name: string;
	readonly cause: string;
}> {
	override get message() {
		return `Failed to update state "${this.name}" in "${this.namespace}": ${this.cause}`;
	}
}

interface StateField<Decoded> {
	getValue: () => Promise<Decoded>;
	safeGetValue: () => Promise<Result<Decoded, GetStateError>>;
	update: (fn: (value: Decoded) => Decoded | Promise<Decoded>) => Promise<void>;
	safeUpdate: (
		fn: (value: Decoded) => Decoded | Promise<Decoded>,
	) => Promise<Result<void, UpdateStateError>>;
}

function implementState<Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
): StateField<Decoded> {
	const getValue = Effect.fn("getValue")(
		function* () {
			const client = yield* HttpClient.HttpClient;
			const body = yield* client
				.get(`/api/namespaces/${namespace}/state/${name}`)
				.pipe(Effect.andThen((response) => response.json));
			return body as Decoded;
		},
		Effect.mapError((error) => new GetStateError({ namespace, name, cause: error.message })),
	);

	const update = Effect.fn("update")(
		function* (fn: (value: Decoded) => Decoded | Promise<Decoded>) {
			const client = yield* HttpClient.HttpClient;
			const current = yield* getValue();
			const next = yield* Effect.tryPromise(async () => fn(current));
			const encoded = yield* definition.encode(next);
			yield* HttpClientRequest.put(`/api/namespaces/${namespace}/state/${name}`).pipe(
				HttpClientRequest.bodyJson(encoded),
				Effect.andThen(client.execute),
			);
		},
		Effect.mapError((error) => {
			const cause = Match.value(error).pipe(
				Match.tag("HttpBodyError", (e) => `failed to encode body (${e.reason._tag})`),
				Match.tag(
					"RequestError",
					"ResponseError",
					"UnknownException",
					"GetStateError",
					"StateValidationError",
					(e) => e.message,
				),
				Match.exhaustive,
			);
			return new UpdateStateError({ namespace, name, cause });
		}),
	);

	return {
		getValue: () => runtime.runPromise(getValue()),
		safeGetValue: mapEffectFnToNeverthrow(runtime, getValue),
		update: (fn) => runtime.runPromise(update(fn)),
		safeUpdate: mapEffectFnToNeverthrow(runtime, update),
	};
}

interface StateDefinitionLambda extends HKT.TypeLambda {
	readonly type: StateDefinition<this["Target"]>;
}

interface StateFieldLambda extends HKT.TypeLambda {
	readonly type: StateField<this["Target"]>;
}

export function loadState<Definitions extends Record<string, unknown>>(
	manifest: StateManifest<Definitions>,
) {
	return mapValues<StateDefinitionLambda, StateFieldLambda, Definitions>(
		manifest.definitions,
		(definition, name) => implementState(manifest.namespace, name, definition),
	);
}
