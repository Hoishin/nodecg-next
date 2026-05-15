import {
	FetchHttpClient,
	HttpClient,
	HttpClientRequest,
} from "@effect/platform";
import type { StateDefinition, StateManifest } from "@nodecg/core";
import { mapValues, type Promisify } from "@nodecg/internal";
import {
	Data,
	Effect,
	type HKT,
	ManagedRuntime,
	Match,
	type Schema,
} from "effect";

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

interface StateFieldEffect<Decoded> {
	getValue: () => Effect.Effect<Decoded, GetStateError, HttpClient.HttpClient>;
	set: (
		value: Decoded,
	) => Effect.Effect<void, UpdateStateError, HttpClient.HttpClient>;
	update: (
		fn: (value: Decoded) => Decoded | Promise<Decoded>,
	) => Effect.Effect<void, UpdateStateError, HttpClient.HttpClient>;
}

type StateField<Decoded> = Promisify<StateFieldEffect<Decoded>>;

function implementStateEffect<Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
): StateFieldEffect<Decoded> {
	const getValue = Effect.fn("getValue")(
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
	);

	const put = Effect.fn("put")(function* (encoded: unknown) {
		const client = yield* HttpClient.HttpClient;
		yield* HttpClientRequest.put(
			`/api/namespaces/${namespace}/state/${name}`,
		).pipe(HttpClientRequest.bodyJson(encoded), Effect.andThen(client.execute));
	});

	const set = Effect.fn("set")(
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
	);

	const update = Effect.fn("update")(
		function* (fn: (value: Decoded) => Decoded | Promise<Decoded>) {
			const current = yield* getValue();
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
	);

	return { getValue, set, update };
}

interface StateDefinitionLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateDefinition<Schema.Schema.Type<this["Target"]>>;
}

interface StateFieldEffectLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateFieldEffect<Schema.Schema.Type<this["Target"]>>;
}

interface StateFieldLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateField<Schema.Schema.Type<this["Target"]>>;
}

export function loadStateEffect<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
>(manifest: StateManifest<Definitions>) {
	return Effect.sync(() =>
		mapValues<StateDefinitionLambda, StateFieldEffectLambda, Definitions>(
			manifest.definitions,
			(definition, name) =>
				implementStateEffect(manifest.namespace, name, definition),
		),
	);
}

export async function loadState<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
>(manifest: StateManifest<Definitions>) {
	const runtime = ManagedRuntime.make(FetchHttpClient.layer);
	const effectState = await runtime.runPromise(loadStateEffect(manifest));
	return mapValues<StateFieldEffectLambda, StateFieldLambda, Definitions>(
		effectState,
		(field) => ({
			getValue: () => runtime.runPromise(field.getValue()),
			set: (value) => runtime.runPromise(field.set(value)),
			update: (fn) => runtime.runPromise(field.update(fn)),
		}),
	);
}
