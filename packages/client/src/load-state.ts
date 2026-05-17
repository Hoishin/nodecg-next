import type { StateDefinition, StateManifest } from "@nodecg/core";
import { mapValues, type PromisifyObject } from "@nodecg/internal";
import {
	Data,
	Effect,
	type HKT,
	Layer,
	ManagedRuntime,
	Match,
	type Schema,
} from "effect";
import type { Promisable } from "type-fest";

import { createHttpStateTransport } from "./http-state-transport.ts";
import {
	StateTransportService,
	type StateTransport,
} from "./state-transport.ts";

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
	getValue: () => Effect.Effect<Decoded, GetStateError, StateTransportService>;
	set: (
		value: Decoded,
	) => Effect.Effect<void, UpdateStateError, StateTransportService>;
	update: (
		fn: (value: Decoded) => Promisable<Decoded>,
	) => Effect.Effect<void, UpdateStateError, StateTransportService>;
}

type StateFieldPromise<Decoded> = PromisifyObject<StateFieldEffect<Decoded>>;

function implementStateEffect<Decoded>(
	namespace: string,
	name: string,
	definition: StateDefinition<Decoded>,
): StateFieldEffect<Decoded> {
	const getValue = Effect.fn("getValue")(
		function* () {
			const transport = yield* StateTransportService;
			const current = yield* transport.read(namespace, name);
			return yield* definition.decode(current);
		},
		Effect.mapError(
			(error) => new GetStateError({ namespace, name, cause: error.message }),
		),
	);

	const set = Effect.fn("set")(
		function* (value: Decoded) {
			const transport = yield* StateTransportService;
			const encoded = yield* definition.encode(value);
			yield* transport.update(namespace, name, encoded);
		},
		Effect.mapError(
			(error) =>
				new UpdateStateError({ namespace, name, cause: error.message }),
		),
	);

	const update = Effect.fn("update")(
		function* (fn: (value: Decoded) => Promisable<Decoded>) {
			const transport = yield* StateTransportService;
			const current = yield* getValue();
			const next = yield* Effect.tryPromise(async () => fn(current));
			const encoded = yield* definition.encode(next);
			yield* transport.update(namespace, name, encoded);
		},
		Effect.mapError((error) => {
			const cause = Match.value(error).pipe(
				Match.tag(
					"UnknownException",
					"GetStateError",
					"StateValidationError",
					"StateNotFound",
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
>(manifest: StateManifest<Definitions>) {
	return Effect.gen(function* () {
		yield* StateTransportService;
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
	stateTransport,
}: {
	manifest: StateManifest<Definitions>;
	stateTransport?: StateTransport | Effect.Effect<StateTransport, never, never>;
}) {
	const runtime = ManagedRuntime.make(
		stateTransport
			? Effect.isEffect(stateTransport)
				? Layer.effect(StateTransportService, stateTransport)
				: Layer.succeed(StateTransportService, stateTransport)
			: Layer.effect(StateTransportService, createHttpStateTransport()),
	);
	const effectState = await runtime.runPromise(loadStateEffect(manifest));
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
