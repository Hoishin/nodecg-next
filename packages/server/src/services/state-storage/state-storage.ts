import {
	Context,
	Data,
	type Duration,
	type Effect,
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

/**
 * StateStorage is platform-agnostic layer to persist state values.
 * Combination of namespace + name can be considered unique.
 * Values here must be JSON-compatible objects, which means
 * it only has JSON-compatible primitives and does not change
 * after `JSON.parse(JSON.stringify(value))`
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
	 * Get the current value with namespace and name
	 */
	read: (
		namespace: string,
		name: string,
	) => Effect.Effect<JsonValue, StateNotFound>;

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
	persistInterval: Duration.DurationInput;
}

export class StateStorageService extends Context.Tag("StateStorage")<
	StateStorageService,
	StateStorage
>() {}
