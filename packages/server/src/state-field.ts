import type { StateDecodeError, StateEncodeError } from "@nodecg/core";
import type { PromisifyObject } from "@nodecg/internal";
import { Data, type Effect, type Scope, type Stream } from "effect";
import type { Promisable, JsonValue } from "type-fest";

import type { StateNotFound } from "./services/state-storage/state-storage.ts";

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

/**
 * Defines server-side behavior of a field of a state
 */
interface StateFieldBase<Decoded> {
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
}

export interface StateField<Decoded> extends StateFieldBase<Decoded> {
	readonly [stateFieldInternal]: StateFieldBase<Decoded> & {
		readonly getEncoded: () => Effect.Effect<JsonValue, StateNotFound>;
		readonly setEncoded: (
			value: JsonValue,
		) => Effect.Effect<void, StateNotFound | StateDecodeError>;
		readonly subscribeEncoded: () => Effect.Effect<
			Stream.Stream<JsonValue>,
			StateNotFound,
			Scope.Scope
		>;
	};
}

export type StateFieldPromise<Decoded> = PromisifyObject<
	Omit<StateField<Decoded>, "get" | "set" | "subscribe">
> & {
	get: () => Decoded;
	set: (value: Decoded) => void;
	subscribe: (handler: (value: Decoded) => Promisable<void>) => void;
};

/**
 * Defines server-side behavior of a computed (server-derived) field
 */
export interface ComputedField<Decoded> {
	/**
	 * Compute the current value from the source fields and decode it
	 */
	readonly get: () => Effect.Effect<Decoded, StateNotFound | StateComputeError>;

	/**
	 * Subscribe to changes. It emits the current value when subscription is live.
	 */
	readonly subscribe: () => Effect.Effect<
		Stream.Stream<Decoded>,
		never,
		Scope.Scope
	>;

	readonly [stateFieldInternal]: {
		readonly getEncoded: () => Effect.Effect<
			JsonValue,
			StateNotFound | StateComputeError | StateEncodeError
		>;
		readonly subscribeEncoded: () => Effect.Effect<
			Stream.Stream<JsonValue>,
			never,
			Scope.Scope
		>;
	};
}

export type ComputedFieldPromise<Decoded> = PromisifyObject<
	Omit<ComputedField<Decoded>, "get" | "subscribe">
> & {
	get: () => Decoded;
	subscribe: (handler: (value: Decoded) => Promisable<void>) => void;
};

/**
 * What the server needs to serve a field over the wire: every field can be read
 * and subscribed; only regular (non-computed) fields can be written.
 */
export interface RegisteredFieldInternal {
	readonly getEncoded: () => Effect.Effect<
		JsonValue,
		StateNotFound | StateComputeError | StateEncodeError
	>;
	readonly subscribeEncoded: () => Effect.Effect<
		Stream.Stream<JsonValue>,
		StateNotFound,
		Scope.Scope
	>;
	readonly setEncoded?: (
		value: JsonValue,
	) => Effect.Effect<void, StateNotFound | StateDecodeError>;
}
