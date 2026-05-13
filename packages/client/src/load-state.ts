import { HttpClient, HttpClientRequest } from "@effect/platform";
import type { HttpClientError } from "@effect/platform/HttpClientError";
import type { StateDefinition, StateDefinitions } from "@nodecg/core";
import { mapEffectFnToNeverthrow, mapValues } from "@nodecg/internal";
import { Data, Effect, Match } from "effect";
import { type Result } from "neverthrow";
import type { JsonValue } from "type-fest";

import { runtime } from "./runtime";

export class GetStateError extends Data.TaggedError("GetStateError")<{
	readonly namespace: string;
	readonly name: string;
	readonly cause: HttpClientError;
}> {
	override get message() {
		return `Failed to get state "${this.name}" in "${this.namespace}": ${this.cause.message}`;
	}
}

interface State<T extends JsonValue> {
	getValue: () => Promise<Result<T, GetStateError>>;
	update: (fn: (value: T) => T | Promise<T>) => Promise<Result<void, string>>;
}

function implementState<T extends JsonValue>(
	namespace: string,
	name: string,
	definition: StateDefinition<T>,
): State<T> {
	const getValue = Effect.fn("getValue")(
		function* () {
			const client = yield* HttpClient.HttpClient;
			const data = yield* client
				.get(`/api/namespaces/${namespace}/state/${name}`)
				.pipe(Effect.andThen((response) => response.json));
			return data as T;
		},
		Effect.mapError((cause) => new GetStateError({ namespace, name, cause })),
	);

	const update = Effect.fn("update")(
		function* (fn: (value: T) => T | Promise<T>) {
			const client = yield* HttpClient.HttpClient;
			const current = yield* getValue();
			const next = yield* Effect.tryPromise(async () => fn(current));
			const parsed = yield* definition.parse(next);
			yield* HttpClientRequest.put(`/api/namespaces/${namespace}/state/${name}`).pipe(
				HttpClientRequest.bodyJson(parsed),
				Effect.andThen(client.execute),
			);
		},
		Effect.mapError((error) => {
			const detail = Match.value(error).pipe(
				Match.when(Match.string, (e) => e),
				Match.tag("HttpBodyError", (e) => `failed to encode body (${e.reason._tag})`),
				Match.tag(
					"RequestError",
					"ResponseError",
					"UnknownException",
					"GetStateError",
					(e) => e.message,
				),
				Match.exhaustive,
			);
			return `Failed to update state "${name}": ${detail}`;
		}),
	);

	return {
		getValue: mapEffectFnToNeverthrow(runtime, getValue),
		update: mapEffectFnToNeverthrow(runtime, update),
	};
}

export function loadState<Definitions extends Record<string, JsonValue>>(
	stateDefinition: StateDefinitions<Definitions>,
): {
	[K in keyof Definitions]: State<Definitions[K]>;
} {
	return mapValues(stateDefinition.definitions, (definition, name) =>
		implementState(stateDefinition.namespace, String(name), definition),
	);
}
