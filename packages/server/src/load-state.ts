import type { StateDefinition, StateManifest } from "@nodecg/core";
import {
	mapValues,
	mapEffectValues,
	zipEffectValues,
	toError,
	promisifyEffectFn,
} from "@nodecg/internal";
import {
	Effect,
	Exit,
	type HKT,
	Layer,
	ManagedRuntime,
	Option,
	type Schema,
	Scope,
	Stream,
} from "effect";
import type { JsonValue, Promisable } from "type-fest";

import { InMemoryStateStorage } from "./services/state-storage/in-memory-state-storage.ts";
import {
	StateNotFound,
	StateStorageService,
	type StateStorage,
} from "./services/state-storage/state-storage.ts";
import {
	type ComputedField,
	type ComputedFieldPromise,
	type RegisteredFieldInternal,
	type StateField,
	type StateFieldPromise,
	StateComputeError,
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

type SourceSnapshot<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
> = {
	readonly [K in keyof Definitions & string]: Schema.Schema.Type<
		Definitions[K]
	>;
};

type ComputeFunctions<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
> = {
	readonly [K in keyof Computed & string]: (
		sources: SourceSnapshot<Definitions>,
	) => Schema.Schema.Type<Computed[K]>;
};

// TODO: support automatic migrations
const migrationDie = () =>
	new Error(
		"Currently stored state value failed schema validation. Migration is not supported yet.",
	);

const implementState = Effect.fn("implementState")(function* <Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
) {
	const storage = yield* StateStorageService;

	const get = Effect.fn("get")(function* () {
		const current = yield* Option.match(storage.read(namespace, name), {
			onNone: () => new StateNotFound({ namespace, name }),
			onSome: Effect.succeed,
		});
		return yield* definition
			.decode(current)
			.pipe(Effect.orDieWith(migrationDie));
	});

	const getEncoded = Effect.fn("getEncoded")(function* () {
		const encoded = yield* Option.match(storage.read(namespace, name), {
			onNone: () => new StateNotFound({ namespace, name }),
			onSome: Effect.succeed,
		});
		yield* definition.decode(encoded).pipe(Effect.orDieWith(migrationDie));
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
				definition.decode(value).pipe(Effect.orDieWith(migrationDie)),
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

const implementComputedState = <Sources, Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
	compute: (sources: Sources) => Decoded,
	readSnapshot: Effect.Effect<Sources, StateNotFound>,
	storage: StateStorage,
): ComputedField<Decoded> => {
	const computeValue = Effect.fn("compute")(function* () {
		const sources = yield* readSnapshot;
		return yield* Effect.try({
			try: () => compute(sources),
			catch: (error) =>
				new StateComputeError({ namespace, name, cause: toError(error) }),
		});
	});

	const getEncoded = Effect.fn("getEncoded")(function* () {
		const value = yield* computeValue();
		return yield* definition.encode(value);
	});

	const subscribeEncoded = Effect.fn("subscribeEncoded")(function* () {
		const changesStream = yield* storage.subscribe();
		const recompute = getEncoded().pipe(
			Effect.map((encoded) =>
				Option.some({ encoded, key: JSON.stringify(encoded) }),
			),
			Effect.catchAll((error) =>
				Effect.logError(
					`Failed to compute state "${namespace}/${name}"`,
					error,
				).pipe(Effect.as(Option.none<{ encoded: JsonValue; key: string }>())),
			),
		);
		const seed = yield* recompute;
		return Stream.concat(
			Stream.fromIterable(Option.isSome(seed) ? [seed.value] : []),
			changesStream.pipe(
				Stream.filter((change) => change.namespace === namespace),
				Stream.mapEffect(() => recompute),
				Stream.filterMap((option) => option),
			),
		).pipe(
			Stream.changesWith((a, b) => a.key === b.key),
			Stream.map((item) => item.encoded),
		);
	});

	const subscribe = Effect.fn("subscribe")(function* () {
		const stream = yield* subscribeEncoded();
		return stream.pipe(
			Stream.mapEffect((value) =>
				definition.decode(value).pipe(Effect.orDieWith(migrationDie)),
			),
		);
	});

	const field: ComputedField<Decoded> = {
		get: computeValue,
		subscribe,
		[stateFieldInternal]: { getEncoded, subscribeEncoded },
	};
	return field;
};

interface StateDefinitionLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateDefinition<Schema.Schema.Type<this["Target"]>>;
}

interface DecodedLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: Schema.Schema.Type<this["Target"]>;
}

interface ComputeFnLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: (sources: this["In"]) => Schema.Schema.Type<this["Target"]>;
}

interface StateFieldLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateField<Schema.Schema.Type<this["Target"]>>;
}

interface StateFieldPromiseLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateFieldPromise<Schema.Schema.Type<this["Target"]>>;
}

interface ComputedFieldLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: ComputedField<Schema.Schema.Type<this["Target"]>>;
}

interface ComputedFieldPromiseLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: ComputedFieldPromise<Schema.Schema.Type<this["Target"]>>;
}

export const stateMetadataKey = Symbol("stateMetadataKey");

type LoadStateArgs<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
> = {
	manifest: StateManifest<Definitions, Computed>;
	initialValues: InitialValues<Definitions>;
} & ([keyof Computed] extends [never]
	? { computed?: undefined }
	: { computed: ComputeFunctions<Definitions, Computed> });

const buildState = <
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
>(
	args: LoadStateArgs<Definitions, Computed>,
) => {
	const { manifest, initialValues, computed } = args;
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
				return Option.isNone(storage.read(manifest.namespace, name))
					? seed
					: Effect.void;
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

		const readSnapshot: Effect.Effect<
			SourceSnapshot<Definitions>,
			StateNotFound
		> = mapEffectValues<StateDefinitionLambda, DecodedLambda, Definitions>()(
			manifest.definitions,
			(definition, name) =>
				Effect.gen(function* () {
					const encoded = yield* Option.match(
						storage.read(manifest.namespace, name),
						{
							onNone: () =>
								new StateNotFound({ namespace: manifest.namespace, name }),
							onSome: Effect.succeed,
						},
					);
					return yield* definition
						.decode(encoded)
						.pipe(Effect.orDieWith(migrationDie));
				}),
		);

		const computedFields = yield* zipEffectValues<
			StateDefinitionLambda,
			ComputeFnLambda,
			ComputedFieldLambda,
			SourceSnapshot<Definitions>,
			Computed
		>()(manifest.computed, computed, (definition, compute, name) =>
			Effect.succeed(
				implementComputedState(
					manifest.namespace,
					name,
					definition,
					compute,
					readSnapshot,
					storage,
				),
			),
		);

		// Eager compute at load and fail-fast validation
		yield* Effect.forEach(
			Object.values(computedFields),
			(field) => field[stateFieldInternal].getEncoded(),
			{ concurrency: "unbounded", discard: true },
		);

		return { fields, computedFields };
	});
};

export function loadStateEffect<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
>(args: LoadStateArgs<Definitions, Computed>) {
	return buildState(args).pipe(
		Effect.map(({ fields, computedFields }) => ({
			...fields,
			...computedFields,
			[stateMetadataKey]: { namespace: args.manifest.namespace },
		})),
	);
}

export async function loadState<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
>(
	args: LoadStateArgs<Definitions, Computed> & {
		storage?: StateStorage | Effect.Effect<StateStorage, never, never>;
	},
) {
	const { manifest, storage } = args;
	const runtime = ManagedRuntime.make(
		storage
			? Effect.isEffect(storage)
				? Layer.effect(StateStorageService, storage)
				: Layer.succeed(StateStorageService, storage)
			: InMemoryStateStorage,
	);

	const { fields: effectFields, computedFields: effectComputedFields } =
		await runtime.runPromise(buildState(args));

	const subscribeAdapter =
		<Decoded, E>(
			subscribe: () => Effect.Effect<Stream.Stream<Decoded>, E, Scope.Scope>,
			name: string,
		) =>
		async (handler: (value: Decoded) => Promisable<void>) => {
			return runtime.runPromise(
				Effect.gen(function* () {
					const scope = yield* Scope.make();
					const subscription = yield* subscribe().pipe(Scope.extend(scope));
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
		};

	const fields = mapValues<
		StateFieldLambda,
		StateFieldPromiseLambda,
		Definitions
	>(effectFields, (field, name) => ({
		get: () => runtime.runSync(field.get()),
		set: (value) => runtime.runSync(field.set(value)),
		update: promisifyEffectFn(field.update, runtime),
		validate: promisifyEffectFn(field.validate, runtime),
		subscribe: subscribeAdapter(field.subscribe, name),
		[stateFieldInternal]: field[stateFieldInternal],
	}));

	const computedFields = mapValues<
		ComputedFieldLambda,
		ComputedFieldPromiseLambda,
		Computed
	>(effectComputedFields, (field, name) => ({
		get: () => runtime.runSync(field.get()),
		subscribe: subscribeAdapter(field.subscribe, name),
		[stateFieldInternal]: field[stateFieldInternal],
	}));

	return {
		...fields,
		...computedFields,
		[stateMetadataKey]: { namespace: manifest.namespace },
	};
}

export type LoadedState = {
	readonly [stateMetadataKey]: { readonly namespace: string };
	readonly [name: string]: {
		readonly [stateFieldInternal]: RegisteredFieldInternal;
	};
};
