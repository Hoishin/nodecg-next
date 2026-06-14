import type { NamespaceManifest, FieldManifest } from "@nodecg/core";
import {
	mapValues,
	mapEffectValues,
	mergeRecords,
	zipEffectValues,
	toError,
	type EffectToPromiseLambda,
	type EffectToSyncLambda,
	type StreamToSubscribeLambda,
	type IdentityLambda,
	type ApplyLambdaToObject,
} from "@nodecg/internal";
import {
	Data,
	Effect,
	Exit,
	type HKT,
	Layer,
	ManagedRuntime,
	Option,
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

export const stateFieldInternal = Symbol("stateFieldInternal");

export class StateUpdateFnError extends Data.TaggedError("StateUpdateFnError")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Update function for state "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

export class StateComputeError extends Data.TaggedError("StateComputeError")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Computing state "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

export type SeedState<State extends Record<string, unknown>> = {
	readonly [K in keyof State & string]: () => Promisable<State[K]>;
};

type SourceSnapshot<State extends Record<string, unknown>> = {
	readonly [K in keyof State & string]: State[K];
};

export type ImplementComputed<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
> = {
	readonly [K in keyof Computed & string]: (
		sources: SourceSnapshot<State>,
	) => Computed[K];
};

type NamespaceOptions<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
> = {
	readonly seedState?: SeedState<State>;
	readonly implementComputed?: ImplementComputed<State, Computed>;
};

export type RequiredOptions<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
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
	codec: FieldManifest<Decoded>,
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

	return {
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
			subscribe,
			getEncoded,
			setEncoded,
			subscribeEncoded,
		},
	};
});

type StateFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementState<Decoded>>
>;
export type StateField<Decoded> = ApplyLambdaToObject<
	StateFieldEffect<Decoded>,
	{
		get: EffectToSyncLambda;
		set: EffectToSyncLambda;
		update: EffectToPromiseLambda;
		validate: EffectToPromiseLambda;
		subscribe: StreamToSubscribeLambda;
		[stateFieldInternal]: IdentityLambda;
	}
>;

const implementComputed = Effect.fn("implementComputed")(function* <
	Sources,
	Decoded,
>(
	namespace: string,
	name: string,
	codec: FieldManifest<Decoded>,
	compute: (sources: Sources) => Decoded,
	readSnapshot: Effect.Effect<Sources, StateNotFound>,
) {
	const storage = yield* StateStorageService;

	const get = Effect.fn("compute")(function* () {
		const sources = yield* readSnapshot;
		return yield* Effect.try({
			try: () => compute(sources),
			catch: (error) =>
				new StateComputeError({ namespace, name, cause: toError(error) }),
		});
	});

	const getEncoded = Effect.fn("getEncoded")(function* () {
		const value = yield* get();
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

	return {
		get,
		subscribe,
		[stateFieldInternal]: {
			get,
			subscribe,
			getEncoded,
			subscribeEncoded,
		},
	};
});

type ComputedFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof implementComputed<unknown, Decoded>>
>;
export type ComputedField<Decoded> = ApplyLambdaToObject<
	ComputedFieldEffect<Decoded>,
	{
		get: EffectToSyncLambda;
		subscribe: StreamToSubscribeLambda;
		[stateFieldInternal]: IdentityLambda;
	}
>;

interface FieldManifestLambda extends HKT.TypeLambda {
	readonly type: FieldManifest<this["Target"]>;
}

interface DecodedLambda extends HKT.TypeLambda {
	readonly type: this["Target"];
}

interface ComputeFnLambda extends HKT.TypeLambda {
	readonly type: (sources: this["In"]) => this["Target"];
}

interface StateFieldEffectLambda extends HKT.TypeLambda {
	readonly type: StateFieldEffect<this["Target"]>;
}

interface StateFieldPromiseLambda extends HKT.TypeLambda {
	readonly type: StateField<this["Target"]>;
}

interface ComputedFieldEffectLambda extends HKT.TypeLambda {
	readonly type: ComputedFieldEffect<this["Target"]>;
}

interface ComputedFieldPromiseLambda extends HKT.TypeLambda {
	readonly type: ComputedField<this["Target"]>;
}

export const stateMetadataKey = Symbol("stateMetadataKey");

const buildNamespace = <
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
	options:
		| (NamespaceOptions<State, Computed> & { readonly storage?: unknown })
		| undefined,
) => {
	const seedState = options?.seedState;
	const computeFns = options?.implementComputed;
	return Effect.gen(function* () {
		const storage = yield* StateStorageService;

		yield* Effect.all(
			Object.entries(manifest.state).map(
				([name, codec]: [string, FieldManifest<unknown>]) => {
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
				},
			),
			{ concurrency: "unbounded" },
		);

		const fields = yield* mapEffectValues<
			FieldManifestLambda,
			StateFieldEffectLambda
		>()((codec, name) => implementState(manifest.namespace, name, codec))(
			manifest.state,
		);

		const readSnapshot: Effect.Effect<
			SourceSnapshot<State>,
			StateNotFound
		> = mapEffectValues<FieldManifestLambda, DecodedLambda>()((codec, name) =>
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
		)(manifest.state);

		const computedFields = yield* zipEffectValues<
			FieldManifestLambda,
			ComputeFnLambda,
			ComputedFieldEffectLambda,
			SourceSnapshot<State>,
			Computed
		>()(manifest.computed, computeFns, (codec, compute, name) =>
			implementComputed(manifest.namespace, name, codec, compute, readSnapshot),
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
	State extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
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
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
	options:
		| (NamespaceOptions<State, Computed> & { readonly storage?: StorageOption })
		| undefined,
): Promise<LoadedNamespace<State, Computed>> {
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

	const state = mapValues<StateFieldEffectLambda, StateFieldPromiseLambda>(
		(field, name) => ({
			get: () => runtime.runSync(field.get()),
			set: (value) => runtime.runSync(field.set(value)),
			update: (fn) => runtime.runPromise(field.update(fn)),
			validate: (value) => runtime.runPromise(field.validate(value)),
			subscribe: subscribeAdapter(field.subscribe, name),
			[stateFieldInternal]: field[stateFieldInternal],
		}),
	)(effectFields);

	const computed = mapValues<
		ComputedFieldEffectLambda,
		ComputedFieldPromiseLambda
	>((field, name) => ({
		get: () => runtime.runSync(field.get()),
		subscribe: subscribeAdapter(field.subscribe, name),
		[stateFieldInternal]: field[stateFieldInternal],
	}))(effectComputedFields);

	return {
		state,
		computed,
		[stateMetadataKey]: { namespace: manifest.namespace },
	};
}

export function loadNamespace<
	State extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
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

interface ImplementedNamespace<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
> {
	readonly manifest: NamespaceManifest<State, Computed, Topic>;
	readonly impl: RequiredOptions<State, Computed> | undefined;
	readonly load: (
		storage?: StorageOption,
	) => ReturnType<typeof loadNamespacePromise<State, Computed, Topic>>;
}

export function implementNamespace<
	State extends Record<string, unknown> = {},
	Computed extends Record<string, unknown> = {},
	Topic extends Record<string, unknown> = {},
>(
	manifest: NamespaceManifest<State, Computed, Topic>,
	...rest: [keyof State | keyof Computed] extends [never]
		? []
		: [impl: RequiredOptions<State, Computed>]
): ImplementedNamespace<State, Computed, Topic> {
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
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
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
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	const Base extends ImplementedNamespace<any, any, any>,
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

export interface LoadedNamespace<
	State extends Record<string, unknown> = Record<string, unknown>,
	Computed extends Record<string, unknown> = Record<string, unknown>,
> {
	readonly [stateMetadataKey]: { readonly namespace: string };
	readonly state: {
		readonly [K in keyof State & string]: StateField<State[K]>;
	};
	readonly computed: {
		readonly [K in keyof Computed & string]: ComputedField<Computed[K]>;
	};
}
