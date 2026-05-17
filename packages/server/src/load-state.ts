import type {
	StateDefinition,
	StateManifest,
	StateValidationError,
} from "@nodecg/core";
import { mapValues, type PromisifyObject } from "@nodecg/internal";
import {
	Data,
	Effect,
	type HKT,
	Layer,
	ManagedRuntime,
	type Schema,
} from "effect";
import type { JsonValue, Promisable } from "type-fest";

import { createInMemoryStateStorage } from "./in-memory-state-storage";
import {
	StateStorageService,
	type StateStorage,
	type StateNotFound,
	type StateSaveFailed,
} from "./state-storage";

export class GetStateError extends Data.TaggedError("GetStateError")<{
	readonly namespace: string;
	readonly name: string;
	readonly cause: Error;
}> {
	override get message() {
		return `Failed to get state "${this.name}" in "${this.namespace}": ${this.cause.message}`;
	}
}

export class UpdateStateError extends Data.TaggedError("UpdateStateError")<{
	readonly namespace: string;
	readonly name: string;
	readonly cause: Error;
}> {
	override get message() {
		return `Failed to update state "${this.name}" in "${this.namespace}": ${this.cause.message}`;
	}
}

export const stateSetEncodedKey = Symbol("stateSetEncodedKey");

export interface StateField<Decoded> {
	readonly get: () => Effect.Effect<
		Decoded,
		GetStateError,
		StateStorageService
	>;
	readonly set: (
		value: Decoded,
	) => Effect.Effect<void, UpdateStateError, StateStorageService>;
	readonly update: (
		fn: (value: Decoded) => Promisable<Decoded>,
	) => Effect.Effect<void, UpdateStateError, StateStorageService>;
	readonly validate: (
		value: Decoded,
	) => Effect.Effect<JsonValue, StateValidationError>;
	readonly [stateSetEncodedKey]: (
		value: unknown,
	) => Effect.Effect<
		void,
		StateValidationError | StateNotFound | StateSaveFailed,
		StateStorageService
	>;
}

export type StateFieldPromise<Decoded> = PromisifyObject<
	StateField<Decoded>,
	"get" | "set" | "update"
>;

type InitialValues<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
> = {
	readonly [K in keyof Definitions & string]: () => Promisable<
		Schema.Schema.Type<Definitions[K]>
	>;
};

function implementStateEffect<Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
): StateField<Decoded> {
	const get = Effect.fn("getValue")(
		function* () {
			const storage = yield* StateStorageService;
			const current = yield* storage.read(namespace, name);
			return yield* definition.decode(current);
		},
		Effect.mapError(
			(error) => new GetStateError({ namespace, name, cause: error }),
		),
	);

	const set = Effect.fn("set")(
		function* (value: Decoded) {
			const storage = yield* StateStorageService;
			const encoded = yield* definition.encode(value);
			yield* storage.update(namespace, name, encoded);
		},
		Effect.mapError(
			(error) => new UpdateStateError({ namespace, name, cause: error }),
		),
	);

	const update = Effect.fn("update")(
		function* (fn: (value: Decoded) => Promisable<Decoded>) {
			const storage = yield* StateStorageService;
			const current = yield* get();
			const next = yield* Effect.tryPromise(async () => fn(current));
			const encoded = yield* definition.encode(next);
			yield* storage.update(namespace, name, encoded);
		},
		Effect.mapError((error) => {
			return new UpdateStateError({ namespace, name, cause: error });
		}),
	);

	const setEncoded = (value: unknown) =>
		Effect.gen(function* () {
			const decoded = yield* definition.decode(value);
			const encoded = yield* definition.encode(decoded);
			const storage = yield* StateStorageService;
			yield* storage.update(namespace, name, encoded);
		});

	return {
		get,
		set,
		update,
		validate: definition.encode,
		[stateSetEncodedKey]: setEncoded,
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

		return {
			...mapValues<StateDefinitionLambda, StateFieldLambda, Definitions>(
				manifest.definitions,
				(definition, name) =>
					implementStateEffect(manifest.namespace, name, definition),
			),
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
			: Layer.sync(StateStorageService, createInMemoryStateStorage),
	);

	const effectState = await runtime.runPromise(
		loadStateEffect({ manifest, initialValues }),
	);

	return {
		...mapValues<StateFieldLambda, StateFieldPromiseLambda, Definitions>(
			effectState,
			(field) => ({
				get: () => runtime.runPromise(field.get()),
				set: (value) => runtime.runPromise(field.set(value)),
				update: (fn) => runtime.runPromise(field.update(fn)),
				validate: field.validate,
				[stateSetEncodedKey]: field[stateSetEncodedKey],
			}),
		),
		[stateMetadataKey]: { namespace: manifest.namespace },
	};
}
