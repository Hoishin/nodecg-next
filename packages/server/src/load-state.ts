import type { StateDefinition, StateManifest } from "@nodecg/core";
import { mapEffectFnToNeverthrow, mapValues } from "@nodecg/internal";
import { Data, Effect, type HKT, Match, type Schema } from "effect";
import { type Result } from "neverthrow";

import { runtime } from "./runtime";
import { store } from "./store";

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
	safeGetValue: () => Promise<Result<Decoded, GetStateError>>;
	set: (value: Decoded) => Promise<void>;
	safeSet: (value: Decoded) => Promise<Result<void, UpdateStateError>>;
	update: (fn: (value: Decoded) => Decoded | Promise<Decoded>) => Promise<void>;
	safeUpdate: (
		fn: (value: Decoded) => Decoded | Promise<Decoded>,
	) => Promise<Result<void, UpdateStateError>>;
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
): StateField<Decoded> {
	const getValue = Effect.fn("getValue")(
		function* () {
			const current = store.get(namespace, name);
			if (current === undefined) {
				return yield* new GetStateError({
					namespace,
					name,
					cause: "state has not been initialised",
				});
			}
			return yield* definition.decode(current);
		},
		Effect.mapError((error) =>
			error._tag === "GetStateError"
				? error
				: new GetStateError({ namespace, name, cause: error.message }),
		),
	);

	const set = Effect.fn("set")(
		function* (value: Decoded) {
			const encoded = yield* definition.encode(value);
			store.set(namespace, name, encoded);
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
			store.set(namespace, name, encoded);
		},
		Effect.mapError((error) => {
			const cause = Match.value(error).pipe(
				Match.tag(
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

	return {
		getValue: () => runtime.runPromise(getValue()),
		safeGetValue: mapEffectFnToNeverthrow(runtime, getValue),
		set: (value) => runtime.runPromise(set(value)),
		safeSet: mapEffectFnToNeverthrow(runtime, set),
		update: (fn) => runtime.runPromise(update(fn)),
		safeUpdate: mapEffectFnToNeverthrow(runtime, update),
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
}: {
	manifest: StateManifest<Definitions>;
	initialValues: InitialValues<Definitions>;
}) {
	await Promise.all(
		Object.entries(initialValues).map(async ([name, thunk]) => {
			if (store.get(manifest.namespace, name) !== undefined) {
				return;
			}
			const definition = manifest.definitions[name];
			if (definition === undefined) {
				throw new Error(`Manifest is missing definition for state "${name}"`);
			}
			const value = await thunk();
			const encoded = await runtime.runPromise(definition.encode(value));
			store.set(manifest.namespace, name, encoded);
		}),
	);

	return mapValues<StateDefinitionLambda, StateFieldLambda, Definitions>(
		manifest.definitions,
		(definition, name) => implementState(manifest.namespace, name, definition),
	);
}
