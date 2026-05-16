import type { StateDefinition, StateManifest } from "@nodecg/core";
import { mapValues, type Promisify } from "@nodecg/internal";
import {
	Data,
	Effect,
	type HKT,
	Layer,
	ManagedRuntime,
	type Schema,
} from "effect";
import type { Promisable } from "type-fest";

import { createInMemoryStateStorage } from "./in-memory-state-storage";
import { StateStorageService, type StateStorage } from "./state-storage";

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

interface StateFieldEffect<Decoded> {
	get: () => Effect.Effect<Decoded, GetStateError, StateStorageService>;
	set: (
		value: Decoded,
	) => Effect.Effect<void, UpdateStateError, StateStorageService>;
	update: (
		fn: (value: Decoded) => Promisable<Decoded>,
	) => Effect.Effect<void, UpdateStateError, StateStorageService>;
}

type StateFieldPromise<Decoded> = Promisify<StateFieldEffect<Decoded>>;

type InitialValues<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
> = {
	[K in keyof Definitions & string]: () => Promisable<
		Schema.Schema.Type<Definitions[K]>
	>;
};

function implementStateEffect<Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
): StateFieldEffect<Decoded> {
	const getValue = Effect.fn("getValue")(
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
			const current = yield* getValue();
			const next = yield* Effect.tryPromise(async () => fn(current));
			const encoded = yield* definition.encode(next);
			yield* storage.update(namespace, name, encoded);
		},
		Effect.mapError((error) => {
			return new UpdateStateError({ namespace, name, cause: error });
		}),
	);

	return { get: getValue, set, update };
}

interface StateDefinitionLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateDefinition<Schema.Schema.Type<this["Target"]>>;
}

interface StateFieldEffectLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateFieldEffect<Schema.Schema.Type<this["Target"]>>;
}

interface StateFieldPromiseLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateFieldPromise<Schema.Schema.Type<this["Target"]>>;
}

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

		return mapValues<
			StateDefinitionLambda,
			StateFieldEffectLambda,
			Definitions
		>(manifest.definitions, (definition, name) =>
			implementStateEffect(manifest.namespace, name, definition),
		);
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
	return mapValues<
		StateFieldEffectLambda,
		StateFieldPromiseLambda,
		Definitions
	>(effectState, (field) => ({
		get: () => runtime.runPromise(field.get()),
		set: (value) => runtime.runPromise(field.set(value)),
		update: (fn) => runtime.runPromise(field.update(fn)),
	}));
}
