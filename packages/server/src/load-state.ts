import type { StateDefinition, StateManifest } from "@nodecg/core";
import {
	mapValues,
	mapEffectValues,
	toError,
	promisifyEffectFn,
} from "@nodecg/internal";
import {
	Effect,
	Exit,
	type HKT,
	Layer,
	ManagedRuntime,
	type Schema,
	Scope,
	Stream,
} from "effect";
import type { JsonValue, Promisable, SimplifyDeep } from "type-fest";

import { createInMemoryStateStorage } from "./services/state-storage/in-memory-state-storage.ts";
import {
	StateStorageService,
	type StateStorage,
} from "./services/state-storage/state-storage.ts";
import {
	type StateField,
	type StateFieldPromise,
	StateUpdateFnError,
	stateFieldInternal,
} from "./state-field.ts";

type InitialValues<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
> = {
	readonly [K in keyof Definitions & string]: () => Promisable<
		Schema.Schema.Type<Definitions[K]>
	>;
};

const implementState = Effect.fn("implementState")(function* <Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
) {
	const storage = yield* StateStorageService;

	const get = Effect.fn("get")(function* () {
		const current = yield* storage.read(namespace, name);
		// TODO: support migration
		return yield* definition
			.decode(current)
			.pipe(
				Effect.orDieWith(
					() =>
						new Error(
							"Currently stored state value failed schema validation. Migration is not supported yet.",
						),
				),
			);
	});

	const getEncoded = Effect.fn("getEncoded")(function* () {
		const encoded = yield* storage.read(namespace, name);
		// TODO: support migration
		yield* definition
			.decode(encoded)
			.pipe(
				Effect.orDieWith(
					() =>
						new Error(
							"Currently stored state value failed schema validation. Migration is not supported yet.",
						),
				),
			);
		return encoded;
	});

	const set = Effect.fn("set")(function* (value: Decoded) {
		const encoded = yield* definition.encode(value);
		yield* storage.update(namespace, name, encoded);
	});

	const setEncoded = Effect.fn("setEncoded")(function* (value: JsonValue) {
		yield* definition.decode(value); // Only for validation
		yield* storage.update(namespace, name, value);
	});

	const update = Effect.fn("update")(function* (
		fn: (value: Decoded, abortSignal: AbortSignal) => Promisable<Decoded>,
	) {
		const current = yield* get();
		const next = yield* Effect.tryPromise({
			try: async (abortSignal) => fn(current, abortSignal),
			catch: (error) =>
				new StateUpdateFnError({ namespace, name, cause: toError(error) }),
		});
		const encoded = yield* definition.encode(next);
		yield* storage.update(namespace, name, encoded);
	});

	const subscribeEncoded = Effect.fn("subscribeEncoded")(function* () {
		const changesStream = yield* storage.subscribe();
		const stateValueStream = changesStream.pipe(
			Stream.filter(
				(change) => change.namespace === namespace && change.name === name,
			),
			Stream.map((change) => change.value),
		);
		const initialValue = yield* getEncoded();
		return Stream.concat(Stream.succeed(initialValue), stateValueStream);
	});

	const subscribe = Effect.fn("subscribe")(function* () {
		const stream = yield* subscribeEncoded();
		return stream.pipe(
			Stream.flatMap((value) =>
				// TODO: support migration
				definition
					.decode(value)
					.pipe(
						Effect.orDieWith(
							() =>
								new Error(
									"Currently stored state value failed schema validation. Migration is not supported yet.",
								),
						),
					),
			),
		);
	});

	const field: StateField<Decoded> = {
		get,
		set,
		update,
		validate: definition.encode,
		subscribe,
		[stateFieldInternal]: {
			get,
			set,
			update,
			validate: definition.encode,
			getEncoded,
			setEncoded,
			subscribe,
			subscribeEncoded,
		},
	};
	return field;
});

interface StateDefinitionLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateDefinition<Schema.Schema.Type<this["Target"]>>;
}

interface StateFieldLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateField<Schema.Schema.Type<this["Target"]>>;
}

interface StateFieldPromiseLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateFieldPromise<Schema.Schema.Type<this["Target"]>>;
}

export const stateMetadataKey = Symbol("stateMetadataKey");

export function loadStateEffect<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
>({
	manifest,
	initialValues,
}: {
	manifest: StateManifest<Definitions>;
	initialValues: InitialValues<Definitions>;
}) {
	return Effect.gen(function* () {
		const storage = yield* StateStorageService;

		yield* Effect.all(
			Object.entries(manifest.definitions).map(([name, definition]) => {
				const seed = Effect.gen(function* () {
					const thunk = initialValues[name];
					if (typeof thunk === "undefined") {
						return yield* Effect.die(
							new Error(`Missing initial value for state "${name}"`),
						);
					}
					const value = yield* Effect.tryPromise(async () => thunk());
					const encoded = yield* definition.encode(value);
					yield* storage.create(manifest.namespace, name, encoded);
				});
				return storage
					.read(manifest.namespace, name)
					.pipe(Effect.catchTag("StateNotFound", () => seed));
			}),
			{ concurrency: "unbounded" },
		);

		const fields = yield* mapEffectValues<
			StateDefinitionLambda,
			StateFieldLambda,
			Definitions
		>()(manifest.definitions, (definition, name) =>
			implementState(manifest.namespace, name, definition),
		);

		return {
			...fields,
			[stateMetadataKey]: { namespace: manifest.namespace },
		};
	});
}

export async function loadState<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
>({
	manifest,
	initialValues,
	storage,
}: {
	manifest: StateManifest<Definitions>;
	initialValues: InitialValues<Definitions>;
	storage?: StateStorage | Effect.Effect<StateStorage, never, never>;
}) {
	const runtime = ManagedRuntime.make(
		storage
			? Effect.isEffect(storage)
				? Layer.effect(StateStorageService, storage)
				: Layer.succeed(StateStorageService, storage)
			: Layer.effect(StateStorageService, createInMemoryStateStorage()),
	);

	const effectState = await runtime.runPromise(
		loadStateEffect({ manifest, initialValues }),
	);

	const fields = mapValues<
		StateFieldLambda,
		StateFieldPromiseLambda,
		Definitions
	>(effectState, (field, name) => ({
		get: promisifyEffectFn(field.get, runtime),
		set: promisifyEffectFn(field.set, runtime),
		update: promisifyEffectFn(field.update, runtime),
		validate: promisifyEffectFn(field.validate, runtime),
		subscribe: async (handler) => {
			return runtime.runPromise(
				Effect.gen(function* () {
					const scope = yield* Scope.make();
					const subscription = yield* field
						.subscribe()
						.pipe(Scope.extend(scope));
					yield* Effect.forkIn(
						Stream.runForEach(subscription, (value) =>
							Effect.tryPromise(async () => handler(value)).pipe(
								Effect.catchAll((error) =>
									Effect.logError(
										`State subscription handler for "${manifest.namespace}/${name}" threw`,
										error,
									),
								),
							),
						).pipe(Effect.ensureErrorType<never>()),
						scope,
					);
					return async () => {
						await runtime.runPromise(Scope.close(scope, Exit.void));
					};
				}),
			);
		},
		[stateFieldInternal]: field[stateFieldInternal],
	}));

	return {
		...fields,
		[stateMetadataKey]: { namespace: manifest.namespace },
	};
}

export type LoadedState = SimplifyDeep<
	| Effect.Effect.Success<ReturnType<typeof loadStateEffect>>
	| Awaited<ReturnType<typeof loadState>>
>;
