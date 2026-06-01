import {
	Context,
	Data,
	type Duration,
	type Effect,
	type Queue,
	type Scope,
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

export interface StateStorage {
	create: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<void, StateAlreadyExists>;
	read: (
		namespace: string,
		name: string,
	) => Effect.Effect<JsonValue, StateNotFound>;
	update: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<void, StateNotFound>;
	subscribe: () => Effect.Effect<
		Queue.Dequeue<StateChange>,
		never,
		Scope.Scope
	>;
	persistInterval: Duration.DurationInput;
}

export class StateStorageService extends Context.Tag("StateStorage")<
	StateStorageService,
	StateStorage
>() {}
