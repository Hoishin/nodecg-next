import {
	Context,
	Data,
	type Effect,
	type Option,
	type Scope,
	type Stream,
} from "effect";
import type { JsonValue } from "type-fest";

export interface StateChange {
	readonly namespace: string;
	readonly name: string;
	readonly value: JsonValue;
}

export class StateNotFound extends Data.TaggedError("StateNotFound")<{
	namespace: string;
	name: string;
}> {
	override readonly message = `State "${this.name}" in "${this.namespace}" does not exist`;
}

export class StateAlreadyExists extends Data.TaggedError("StateAlreadyExists")<{
	namespace: string;
	name: string;
}> {
	override readonly message = `State "${this.name}" in "${this.namespace}" already exists`;
}

export class StatePersistError extends Data.TaggedError("StatePersistError")<{
	cause: Error;
}> {
	override readonly message = `Failed to persist state: ${this.cause.message}`;
}

/**
 * StateStorage is platform-agnostic layer to persist state values.
 */
export interface StateStorage {
	/**
	 * Create a new state entry in storage. Must supply valid initial value.
	 */
	create: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<void, StateAlreadyExists>;

	/**
	 * Read the current in-memory value synchronously.
	 */
	read: (namespace: string, name: string) => Option.Option<JsonValue>;

	/**
	 * Update the already-existing state value with a new value
	 */
	update: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<void, StateNotFound>;

	/**
	 * Subscribe to changes. Returns one stream that contains all changes.
	 */
	subscribe: () => Effect.Effect<
		Stream.Stream<StateChange>,
		never,
		Scope.Scope
	>;

	/**
	 * Force a durable write of all pending in-memory state and confirm it.
	 */
	flush: () => Effect.Effect<void, StatePersistError>;
}

export class StateStorageService extends Context.Tag("StateStorage")<
	StateStorageService,
	StateStorage
>() {}
