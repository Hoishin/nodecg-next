import type { NamespaceManifest, FieldCodec } from "@nodecg/core";
import {
	mapValues,
	mapEffectValues,
	mergeRecords,
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

export type SeedState<
	State extends Record<string, Schema.Schema<any, any, never>>,
> = {
	readonly [K in keyof State & string]: () => Promisable<
		Schema.Schema.Type<State[K]>
	>;
};

type SourceSnapshot<
	State extends Record<string, Schema.Schema<any, any, never>>,
> = {
	readonly [K in keyof State & string]: Schema.Schema.Type<State[K]>;
};

export type ImplementComputed<
	State extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
> = {
	readonly [K in keyof Computed & string]: (
		sources: SourceSnapshot<State>,
	) => Schema.Schema.Type<Computed[K]>;
};

type NamespaceOptions<
	State extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
> = {
	readonly seedState?: SeedState<State>;
	readonly implementComputed?: ImplementComputed<State, Computed>;
};

export type RequiredOptions<
	State extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
> = ([keyof State] extends [never]
	? {}
	: { readonly seedState: SeedState<State> }) &
	([keyof Computed] extends [never]
		? {}
		: { readonly implementComputed: ImplementComputed<State, Computed> });

// TODO: support automatic migrations
const migrationDie = () =>
	new Error(
		"Currently stored state value failed schema validation. Migration is not supported yet.",
	);

const implementState = Effect.fn("implementState")(function* <Decoded>(
	namespace: string,
	name: string,
	codec: FieldCodec<Decoded>,
) {
	const storage = yield* StateStorageService;

	const get = Effect.fn("get")(function* () {
		const current = yield* Option.match(storage.read(namespace, name), {
			onNone: () => new StateNotFound({ namespace, name }),
			onSome: Effect.succeed,
		});
		return yield* codec.decode(current).pipe(Effect.orDieWith(migrationDie));
	});

	const getEncoded = Effect.fn("getEncoded")(function* () {
		const encoded = yield* Option.match(storage.read(namespace, name), {
			onNone: () => new StateNotFound({ namespace, name }),
			onSome: Effect.succeed,
		});
		yield* codec.decode(encoded).pipe(Effect.orDieWith(migrationDie));
		return encoded;
	});

	const set = Effect.fn("set")(function* (value: Decoded) {
		const encoded = yield* codec.encode(value);
		yield* storage.update(namespace, name, encoded);
	});

	const setEncoded = Effect.fn("setEncoded")(function* (value: JsonValue) {
		yield* codec.decode(value); // Only for validation
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
		const encoded = yield* codec.encode(next);
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
				codec.decode(value).pipe(Effect.orDieWith(migrationDie)),
			),
		);
	});

	const field: StateField<Decoded> = {
		get,
		set,
		update,
		validate: codec.encode,
		subscribe,
		[stateFieldInternal]: {
			get,
			set,
			update,
			validate: codec.encode,
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
	codec: FieldCodec<Decoded>,
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
		return yield* codec.encode(value);
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
				codec.decode(value).pipe(Effect.orDieWith(migrationDie)),
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

interface FieldCodecLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: FieldCodec<Schema.Schema.Type<this["Target"]>>;
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

const buildNamespace = <
	State extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
	Topic extends Record<string, Schema.Schema<any, any, never>>,
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
	options:
		| (NamespaceOptions<State, Computed> & { readonly storage?: unknown })
		| undefined,
) => {
	const seedState = options?.seedState;
	const implementComputed = options?.implementComputed;
	return Effect.gen(function* () {
		const storage = yield* StateStorageService;

		yield* Effect.all(
			Object.entries(manifest.state).map(([name, codec]) => {
				const seed = Effect.gen(function* () {
					const thunk = seedState?.[name];
					if (typeof thunk === "undefined") {
						return yield* Effect.die(
							new Error(`Missing seed value for state "${name}"`),
						);
					}
					const value = yield* Effect.tryPromise(async () => thunk());
					const encoded = yield* codec.encode(value);
					yield* storage.create(manifest.namespace, name, encoded);
				});
				return Option.isNone(storage.read(manifest.namespace, name))
					? seed
					: Effect.void;
			}),
			{ concurrency: "unbounded" },
		);

		const fields = yield* mapEffectValues<
			FieldCodecLambda,
			StateFieldLambda,
			State
		>()(manifest.state, (codec, name) =>
			implementState(manifest.namespace, name, codec),
		);

		const readSnapshot: Effect.Effect<
			SourceSnapshot<State>,
			StateNotFound
		> = mapEffectValues<FieldCodecLambda, DecodedLambda, State>()(
			manifest.state,
			(codec, name) =>
				Effect.gen(function* () {
					const encoded = yield* Option.match(
						storage.read(manifest.namespace, name),
						{
							onNone: () =>
								new StateNotFound({ namespace: manifest.namespace, name }),
							onSome: Effect.succeed,
						},
					);
					return yield* codec
						.decode(encoded)
						.pipe(Effect.orDieWith(migrationDie));
				}),
		);

		const computedFields = yield* zipEffectValues<
			FieldCodecLambda,
			ComputeFnLambda,
			ComputedFieldLambda,
			SourceSnapshot<State>,
			Computed
		>()(manifest.computed, implementComputed, (codec, compute, name) =>
			Effect.succeed(
				implementComputedState(
					manifest.namespace,
					name,
					codec,
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

export function loadNamespaceEffect<
	State extends Record<string, Schema.Schema<any, any, never>> = {},
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
	Topic extends Record<string, Schema.Schema<any, any, never>> = {},
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
	...rest: [keyof State | keyof Computed] extends [never]
		? []
		: [options: RequiredOptions<State, Computed>]
) {
	const [options] = rest;
	return buildNamespace(manifest, options).pipe(
		Effect.map(({ fields, computedFields }) => ({
			state: fields,
			computed: computedFields,
			[stateMetadataKey]: { namespace: manifest.namespace },
		})),
	);
}

type StorageOption = StateStorage | Effect.Effect<StateStorage, never, never>;

async function loadNamespacePromise<
	State extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
	Topic extends Record<string, Schema.Schema<any, any, never>>,
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
	options:
		| (NamespaceOptions<State, Computed> & { readonly storage?: StorageOption })
		| undefined,
) {
	const storage = options?.storage;
	const runtime = ManagedRuntime.make(
		storage
			? Effect.isEffect(storage)
				? Layer.effect(StateStorageService, storage)
				: Layer.succeed(StateStorageService, storage)
			: InMemoryStateStorage,
	);

	const { fields: effectFields, computedFields: effectComputedFields } =
		await runtime.runPromise(buildNamespace(manifest, options));

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

	const state = mapValues<StateFieldLambda, StateFieldPromiseLambda, State>(
		effectFields,
		(field, name) => ({
			get: () => runtime.runSync(field.get()),
			set: (value) => runtime.runSync(field.set(value)),
			update: promisifyEffectFn(field.update, runtime),
			validate: promisifyEffectFn(field.validate, runtime),
			subscribe: subscribeAdapter(field.subscribe, name),
			[stateFieldInternal]: field[stateFieldInternal],
		}),
	);

	const computed = mapValues<
		ComputedFieldLambda,
		ComputedFieldPromiseLambda,
		Computed
	>(effectComputedFields, (field, name) => ({
		get: () => runtime.runSync(field.get()),
		subscribe: subscribeAdapter(field.subscribe, name),
		[stateFieldInternal]: field[stateFieldInternal],
	}));

	return {
		state,
		computed,
		[stateMetadataKey]: { namespace: manifest.namespace },
	};
}

export function loadNamespace<
	State extends Record<string, Schema.Schema<any, any, never>> = {},
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
	Topic extends Record<string, Schema.Schema<any, any, never>> = {},
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
	...rest: [keyof State | keyof Computed] extends [never]
		? []
		: [
				options: RequiredOptions<State, Computed> & {
					readonly storage?: StorageOption;
				},
			]
) {
	return loadNamespacePromise(manifest, rest[0]);
}

interface Implemented<
	State extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
	Topic extends Record<string, Schema.Schema<any, any, never>>,
> {
	readonly manifest: NamespaceManifest<State, Computed, Topic>;
	readonly impl: RequiredOptions<State, Computed> | undefined;
	readonly load: (
		storage?: StorageOption,
	) => ReturnType<typeof loadNamespacePromise<State, Computed, Topic>>;
}

// pure declaration — no storage dependency; `load` is the single injection point
export function implementNamespace<
	State extends Record<string, Schema.Schema<any, any, never>> = {},
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
	Topic extends Record<string, Schema.Schema<any, any, never>> = {},
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
	...rest: [keyof State | keyof Computed] extends [never]
		? []
		: [impl: RequiredOptions<State, Computed>]
): Implemented<State, Computed, Topic> {
	const [impl] = rest;
	return {
		manifest,
		impl,
		load: (storage) => loadNamespacePromise(manifest, { ...impl, storage }),
	};
}

type RelaxCovered<O, Covered extends PropertyKey> = Omit<O, Covered> &
	Partial<Pick<O, Extract<keyof O, Covered>>>;

type ExtensionSupplement<
	State extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
	CoveredState extends PropertyKey,
	CoveredComputed extends PropertyKey,
> = ([keyof Omit<State, CoveredState>] extends [never]
	? { readonly seedState?: RelaxCovered<SeedState<State>, CoveredState> }
	: { readonly seedState: RelaxCovered<SeedState<State>, CoveredState> }) &
	([keyof Omit<Computed, CoveredComputed>] extends [never]
		? {
				readonly implementComputed?: RelaxCovered<
					ImplementComputed<State, Computed>,
					CoveredComputed
				>;
			}
		: {
				readonly implementComputed: RelaxCovered<
					ImplementComputed<State, Computed>,
					CoveredComputed
				>;
			});

export function loadExtendedNamespace<
	State extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
	Topic extends Record<string, Schema.Schema<any, any, never>>,
	const Base extends Implemented<any, any, any>,
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
	implemented: Base,
	additional: ExtensionSupplement<
		State,
		Computed,
		keyof Base["manifest"]["state"] & string,
		keyof Base["manifest"]["computed"] & string
	>,
	storage?: StorageOption,
) {
	const merged: NamespaceOptions<State, Computed> = {
		seedState: mergeRecords<SeedState<State>>(
			implemented.impl?.seedState,
			additional.seedState,
		),
		implementComputed: mergeRecords<ImplementComputed<State, Computed>>(
			implemented.impl?.implementComputed,
			additional.implementComputed,
		),
	};
	return loadNamespacePromise(manifest, { ...merged, storage });
}

export type LoadedNamespace = {
	readonly [stateMetadataKey]: { readonly namespace: string };
	readonly state: {
		readonly [name: string]: {
			readonly [stateFieldInternal]: RegisteredFieldInternal;
		};
	};
	readonly computed: {
		readonly [name: string]: {
			readonly [stateFieldInternal]: RegisteredFieldInternal;
		};
	};
};

// TODO: move to its own file. Also state/computed/topic should be completely separated (could be same name!)
export const buildFieldRegistry = (
	namespaces: ReadonlyArray<LoadedNamespace>,
) => {
	const registry = new Map<string, Map<string, RegisteredFieldInternal>>();
	for (const loaded of namespaces) {
		const { namespace } = loaded[stateMetadataKey];
		const fields =
			registry.get(namespace) ?? new Map<string, RegisteredFieldInternal>();
		for (const [name, field] of Object.entries(loaded.state)) {
			fields.set(name, field[stateFieldInternal]);
		}
		for (const [name, field] of Object.entries(loaded.computed)) {
			fields.set(name, field[stateFieldInternal]);
		}
		registry.set(namespace, fields);
	}
	return registry;
};
