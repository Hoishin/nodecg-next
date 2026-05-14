import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import type { StateDefinition, StateManifest } from "@nodecg/core";
import { mapValues } from "@nodecg/internal";
import { Data, Effect, type HKT, Match, type Schema } from "effect";

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
	getValueEffect: () => Effect.Effect<Decoded, GetStateError>;
	set: (value: Decoded) => Promise<void>;
	setEffect: (value: Decoded) => Effect.Effect<void, UpdateStateError>;
	update: (fn: (value: Decoded) => Decoded | Promise<Decoded>) => Promise<void>;
	updateEffect: (
		fn: (value: Decoded) => Decoded | Promise<Decoded>,
	) => Effect.Effect<void, UpdateStateError>;
}

function implementState<Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
): StateField<Decoded> {
	const getValueEffect = Effect.fn("getValue")(
		function* () {
			const client = yield* HttpClient.HttpClient;
			const body = yield* client
				.get(`/api/namespaces/${namespace}/state/${name}`)
				.pipe(Effect.andThen((response) => response.json));
			return yield* definition.decode(body);
		},
		Effect.mapError(
			(error) => new GetStateError({ namespace, name, cause: error.message }),
		),
		Effect.provide(FetchHttpClient.layer),
	);

	const put = Effect.fn("put")(function* (encoded: unknown) {
		const client = yield* HttpClient.HttpClient;
		yield* HttpClientRequest.put(
			`/api/namespaces/${namespace}/state/${name}`,
		).pipe(HttpClientRequest.bodyJson(encoded), Effect.andThen(client.execute));
	});

	const setEffect = Effect.fn("set")(
		function* (value: Decoded) {
			const encoded = yield* definition.encode(value);
			yield* put(encoded);
		},
		Effect.mapError((error) => {
			const cause = Match.value(error).pipe(
				Match.tag(
					"HttpBodyError",
					(e) => `failed to encode body (${e.reason._tag})`,
				),
				Match.tag(
					"RequestError",
					"ResponseError",
					"StateValidationError",
					(e) => e.message,
				),
				Match.exhaustive,
			);
			return new UpdateStateError({ namespace, name, cause });
		}),
		Effect.provide(FetchHttpClient.layer),
	);

	const updateEffect = Effect.fn("update")(
		function* (fn: (value: Decoded) => Decoded | Promise<Decoded>) {
			const current = yield* getValueEffect();
			const next = yield* Effect.tryPromise(async () => fn(current));
			const encoded = yield* definition.encode(next);
			yield* put(encoded);
		},
		Effect.mapError((error) => {
			const cause = Match.value(error).pipe(
				Match.tag(
					"HttpBodyError",
					(e) => `failed to encode body (${e.reason._tag})`,
				),
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
		Effect.provide(FetchHttpClient.layer),
	);

	return {
		getValue: () => Effect.runPromise(getValueEffect()),
		getValueEffect,
		set: (value) => Effect.runPromise(setEffect(value)),
		setEffect,
		update: (fn) => Effect.runPromise(updateEffect(fn)),
		updateEffect,
	};
}

interface StateDefinitionLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateDefinition<Schema.Schema.Type<this["Target"]>>;
}

interface StateFieldLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateField<Schema.Schema.Type<this["Target"]>>;
}

export function loadState<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
>(manifest: StateManifest<Definitions>) {
	return mapValues<StateDefinitionLambda, StateFieldLambda, Definitions>(
		manifest.definitions,
		(definition, name) => implementState(manifest.namespace, name, definition),
	);
}
