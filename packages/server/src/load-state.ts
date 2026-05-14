import type { StateDefinition, StateManifest } from "@nodecg/core";
import { mapValues } from "@nodecg/internal";
import { Data, Effect, type HKT, Match, type Schema } from "effect";

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

type InitialValues<
	Definitions extends Record<string, Schema.Schema<any, any, never>>,
> = {
	[K in keyof Definitions & string]: () =>
		| Schema.Schema.Type<Definitions[K]>
		| Promise<Schema.Schema.Type<Definitions[K]>>;
};

function implementState<Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
	storage: StateStorageAdapter,
): StateField<Decoded> {
	const getValueEffect = Effect.fn("getValue")(
		function* () {
			const current = yield* storage.get(namespace, name);
			return yield* definition.decode(current);
		},
		Effect.mapError(
			(error) => new GetStateError({ namespace, name, cause: error.message }),
		),
	);

	const setEffect = Effect.fn("set")(
		function* (value: Decoded) {
			const encoded = yield* definition.encode(value);
			yield* storage.set(namespace, name, encoded);
		},
		Effect.mapError(
			(error) =>
				new UpdateStateError({ namespace, name, cause: error.message }),
		),
	);

	const updateEffect = Effect.fn("update")(
		function* (fn: (value: Decoded) => Decoded | Promise<Decoded>) {
			const current = yield* getValueEffect();
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
	await Promise.all(
		Object.entries(initialValues).map(async ([name, thunk]) => {
			const existing = await Effect.runPromise(
				Effect.either(storage.get(manifest.namespace, name)),
			);
			if (existing._tag === "Right") return;
			if (existing.left._tag !== "StateNotFound") {
				throw existing.left;
			}
			const definition = manifest.definitions[name];
			if (definition === undefined) {
				throw new Error(`Manifest is missing definition for state "${name}"`);
			}
			const value = await thunk();
			const encoded = await Effect.runPromise(definition.encode(value));
			await Effect.runPromise(storage.set(manifest.namespace, name, encoded));
		}),
	);

	return mapValues<StateDefinitionLambda, StateFieldLambda, Definitions>(
		manifest.definitions,
		(definition, name) =>
			implementState(manifest.namespace, name, definition, storage),
	);
}
