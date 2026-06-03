import type { StateDecodeError, StateEncodeError } from "@nodecg/core";
import type { PromisifyObject } from "@nodecg/internal";
import { Data, type Effect, type Scope, type Stream } from "effect";
import type {
	Promisable,
	JsonValue,
	OverrideProperties,
	Simplify,
} from "type-fest";

import type { StateNotFound } from "./services/state-storage/state-storage.ts";

export const stateFieldInternal = Symbol("stateFieldInternal");

export class StateUpdateFnError extends Data.TaggedError("StateUpdateFnError")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Update function for state "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

/**
 * Defines server-side behavior of a field of a state
 */
export interface StateField<Decoded> {
	/**
	 * Read value from state storage and decode
	 */
	readonly get: () => Effect.Effect<Decoded, StateNotFound>;

	/**
	 * Validate value and write it in storage
	 */
	readonly set: (
		value: Decoded,
	) => Effect.Effect<void, StateNotFound | StateEncodeError>;

	/**
	 * Run provided async function, validate the result, and write it in storage
	 */
	readonly update: (
		fn: (value: Decoded) => Promisable<Decoded>,
	) => Effect.Effect<
		void,
		StateNotFound | StateEncodeError | StateUpdateFnError
	>;

	/**
	 * Validate value and encode to JSON-compatible object
	 */
	readonly validate: (
		value: Decoded,
	) => Effect.Effect<JsonValue, StateEncodeError>;

	/**
	 * Subscribe to changes. It emits the current value when subscription is live.
	 */
	readonly subscribe: () => Effect.Effect<
		Stream.Stream<Decoded>,
		StateNotFound,
		Scope.Scope
	>;

	readonly [stateFieldInternal]: Simplify<
		{
			[K in keyof StateField<Decoded> as K extends string
				? K
				: never]: StateField<Decoded>[K];
		} & {
			readonly getEncoded: () => Effect.Effect<JsonValue, StateNotFound>;
			readonly setEncoded: (
				value: JsonValue,
			) => Effect.Effect<void, StateNotFound | StateDecodeError>;
			readonly subscribeEncoded: () => Effect.Effect<
				Stream.Stream<JsonValue>,
				StateNotFound,
				Scope.Scope
			>;
		}
	>;
}

export type StateFieldPromise<Decoded> = OverrideProperties<
	PromisifyObject<StateField<Decoded>>,
	{
		subscribe: (handler: (value: Decoded) => Promisable<void>) => void;
	}
>;
