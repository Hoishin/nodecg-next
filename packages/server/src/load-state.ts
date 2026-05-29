import type { StateDefinition, StateManifest } from "@nodecg/core";
import {
	mapValues,
	mapEffectValues,
	toError,
	promisifyEffectFn,
} from "@nodecg/internal";
import {
	Effect,
	type HKT,
	Layer,
	ManagedRuntime,
	type Schema,
	Stream,
} from "effect";
import type { Promisable, SimplifyDeep } from "type-fest";

import {
	type StateField,
	type StateFieldPromise,
	StateUpdateFnError,
	stateFieldInternal,
} from "./models/state-field.ts";
import { createInMemoryStateStorage } from "./services/state-storage/in-memory-state-storage.ts";
import {
	StateStorageService,
	type StateStorage,
} from "./services/state-storage/state-storage.ts";

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
		return yield* definition.decode(current);
	});

	const set = Effect.fn("set")(function* (value: Decoded) {
		const encoded = yield* definition.encode(value);
		yield* storage.update(namespace, name, encoded);
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

	const getEncoded = Effect.fn("getEncoded")(function* () {
		const decoded = yield* get();
		return yield* definition.encode(decoded);
	});

	const setEncoded = Effect.fn("setEncoded")(function* (value: unknown) {
		const decoded = yield* definition.decode(value);
		const encoded = yield* definition.encode(decoded);
		yield* storage.update(namespace, name, encoded);
	});

	const subscribeEncoded = () =>
		storage.changes.pipe(
			Stream.filter(
				(change) => change.namespace === namespace && change.name === name,
			),
			Stream.map((change) => change.value),
		);

	const subscribe = () =>
		subscribeEncoded().pipe(
			Stream.flatMap((value) => definition.decode(value)),
		);

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
	>(effectState, (field) => ({
		get: promisifyEffectFn(field.get),
		set: promisifyEffectFn(field.set),
		update: promisifyEffectFn(field.update),
		validate: promisifyEffectFn(field.validate),
		subscribe: (handler) => {
			field.subscribe().pipe(
				Stream.runForEach((value) =>
					Effect.try({
						try: () => handler(value),
						catch: (error) => Effect.die(error), // TODO: proper handling
					}),
				),
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
