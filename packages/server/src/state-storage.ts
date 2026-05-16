import { Context, Data, type Duration, type Effect } from "effect";
import type { JsonValue } from "type-fest";

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

export class StateGetFailed extends Data.TaggedError("StateGetFailed")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Failed to get state "${this.name}" in "${this.namespace}": ${this.cause.message}`;
}

export class StateSaveFailed extends Data.TaggedError("StateSaveFailed")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Failed to save state "${this.name}" in "${this.namespace}": ${this.cause.message}`;
}

export interface StateStorage {
	create: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<void, StateAlreadyExists | StateSaveFailed>;
	read: (
		namespace: string,
		name: string,
	) => Effect.Effect<JsonValue, StateNotFound | StateGetFailed>;
	update: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<void, StateNotFound | StateSaveFailed>;
	persistInterval: Duration.DurationInput;
}

export class StateStorageService extends Context.Tag("StateStorage")<
	StateStorageService,
	StateStorage
>() {}
