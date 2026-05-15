import type { StateDefinition, StateManifest } from "@nodecg/core";
import { mapValues, type Promisify } from "@nodecg/internal";
import {
	Data,
	Effect,
	type HKT,
	Layer,
	ManagedRuntime,
	Match,
	type Schema,
} from "effect";

import type { StateStorageAdapter } from "./state-storage";
import { inMemoryStateStorage } from "./state-storage-in-memory";

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
	getValue: () => Effect.Effect<Decoded, GetStateError>;
	set: (value: Decoded) => Effect.Effect<void, UpdateStateError>;
	update: (
		fn: (value: Decoded) => Decoded | Promise<Decoded>,
	) => Effect.Effect<void, UpdateStateError>;
}

type StateFieldPromise<Decoded> = Promisify<StateFieldEffect<Decoded>>;

type InitialValues<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
> = {
	[K in keyof Definitions & string]: () =>
		| Schema.Schema.Type<Definitions[K]>
		| Promise<Schema.Schema.Type<Definitions[K]>>;
};

function implementStateEffect<Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
	storage: StateStorageAdapter,
): StateFieldEffect<Decoded> {
	const getValue = Effect.fn("getValue")(
		function* () {
			const current = yield* storage.get(namespace, name);
			return yield* definition.decode(current);
		},
		Effect.mapError(
			(error) => new GetStateError({ namespace, name, cause: error.message }),
		),
	);

	const set = Effect.fn("set")(
		function* (value: Decoded) {
			const encoded = yield* definition.encode(value);
			yield* storage.set(namespace, name, encoded);
		},
		Effect.mapError(
			(error) =>
				new UpdateStateError({ namespace, name, cause: error.message }),
		),
	);

	const update = Effect.fn("update")(
		function* (fn: (value: Decoded) => Decoded | Promise<Decoded>) {
			const current = yield* getValue();
			const next = yield* Effect.tryPromise(async () => fn(current));
			const encoded = yield* definition.encode(next);
			yield* storage.set(namespace, name, encoded);
		},
		Effect.mapError((error) => {
			const cause = Match.value(error).pipe(
				Match.tag(
					"UnknownException",
					"GetStateError",
					"StateValidationError",
					"StateSaveFailed",
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

interface StateFieldPromiseLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: StateFieldPromise<Schema.Schema.Type<this["Target"]>>;
}

export function loadStateEffect<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
>({
	manifest,
	initialValues,
	storage = inMemoryStateStorage,
}: {
	manifest: StateManifest<Definitions>;
	initialValues: InitialValues<Definitions>;
	storage?: StateStorageAdapter;
}) {
	return Effect.gen(function* () {
		yield* Effect.all(
			Object.entries(initialValues).map(([name, thunk]) =>
				Effect.gen(function* () {
					const existing = yield* Effect.either(
						storage.get(manifest.namespace, name),
					);
					if (existing._tag === "Right") return;
					if (existing.left._tag !== "StateNotFound") {
						return yield* existing.left;
					}
					const definition = manifest.definitions[name];
					if (definition === undefined) {
						return yield* Effect.die(
							new Error(`Manifest is missing definition for state "${name}"`),
						);
					}
					const value = yield* Effect.tryPromise(async () => thunk());
					const encoded = yield* definition.encode(value);
					yield* storage.set(manifest.namespace, name, encoded);
				}),
			),
			{ concurrency: "unbounded" },
		);

		return mapValues<
			StateDefinitionLambda,
			StateFieldEffectLambda,
			Definitions
		>(manifest.definitions, (definition, name) =>
			implementStateEffect(manifest.namespace, name, definition, storage),
		);
	});
}

export async function loadState<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
>({
	manifest,
	initialValues,
	storage = inMemoryStateStorage,
}: {
	manifest: StateManifest<Definitions>;
	initialValues: InitialValues<Definitions>;
	storage?: StateStorageAdapter;
}) {
	const runtime = ManagedRuntime.make(Layer.empty);
	const effectState = await runtime.runPromise(
		loadStateEffect({ manifest, initialValues, storage }),
	);
	return mapValues<
		StateFieldEffectLambda,
		StateFieldPromiseLambda,
		Definitions
	>(effectState, (field) => ({
		getValue: () => runtime.runPromise(field.getValue()),
		set: (value) => runtime.runPromise(field.set(value)),
		update: (fn) => runtime.runPromise(field.update(fn)),
	}));
}
