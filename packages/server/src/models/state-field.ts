import type { StateValidationError } from "@nodecg/core";
import type { PromisifyObject } from "@nodecg/internal";
import { Data, type Effect, type Stream } from "effect";
import type { Promisable, JsonValue } from "type-fest";

import type {
	StateGetFailed,
	StateNotFound,
	StateSaveFailed,
} from "../services/state-storage/state-storage.ts";

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
	readonly get: () => Effect.Effect<
		Decoded,
		StateGetFailed | StateNotFound | StateValidationError
	>;
	/**
	 * Validate value and write it in storage
	 */
	readonly set: (
		value: Decoded,
	) => Effect.Effect<
		void,
		StateValidationError | StateNotFound | StateSaveFailed
	>;
	/**
	 * Run provided async function, validate the result, and write it in storage
	 */
	readonly update: (
		fn: (value: Decoded) => Promisable<Decoded>,
	) => Effect.Effect<
		void,
		| StateUpdateFnError
		| StateValidationError
		| StateGetFailed
		| StateNotFound
		| StateSaveFailed
	>;

	/**
	 * Validate value and encode to JSON-compatible object
	 */
	readonly validate: (
		value: Decoded,
	) => Effect.Effect<JsonValue, StateValidationError>;

	readonly subscribe: () => Stream.Stream<Decoded, StateValidationError>;

	readonly [stateFieldInternal]: Pick<
		StateField<Decoded>,
		"get" | "set" | "update" | "validate" | "subscribe"
	> & {
		readonly setEncoded: (
			value: unknown,
		) => Effect.Effect<
			void,
			StateValidationError | StateNotFound | StateSaveFailed
		>;
		readonly subscribeEncoded: () => Stream.Stream<JsonValue>;
	};
}

export type StateFieldPromise<Decoded> = Omit<
	PromisifyObject<StateField<Decoded>>,
	"subscribe"
> & {
	subscribe: (handler: (value: Decoded) => void) => void;
};
