import { Context, Data, type Effect } from "effect";
import type { JsonValue } from "type-fest";

// TODO: it is not just "State"
export class StateNotFound extends Data.TaggedError("StateNotFound")<{
	namespace: string;
	name: string;
}> {
	override readonly message = `State "${this.name}" in "${this.namespace}" does not exist`;
}

// TODO: not just "State"
export class StatePermissionDenied extends Data.TaggedError(
	"StatePermissionDenied",
)<{
	namespace: string;
	name: string;
}> {
	override readonly message = `Permission denied for "${this.name}" in "${this.namespace}"`;
}

// TODO: not just "State"
export class StateGetFailed extends Data.TaggedError("StateGetFailed")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Failed to get state "${this.name}" in "${this.namespace}": ${this.cause.message}`;
}

// TODO: not just "State"
export class StateSaveFailed extends Data.TaggedError("StateSaveFailed")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Failed to save state "${this.name}" in "${this.namespace}": ${this.cause.message}`;
}

// TODO: not just "State"
export interface StateTransport {
	readState: (
		namespace: string,
		name: string,
	) => Effect.Effect<
		JsonValue,
		StateNotFound | StatePermissionDenied | StateGetFailed
	>;
	readComputed: (
		namespace: string,
		name: string,
	) => Effect.Effect<
		JsonValue,
		StateNotFound | StatePermissionDenied | StateGetFailed
	>;
	updateState: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<
		void,
		StateNotFound | StatePermissionDenied | StateSaveFailed
	>;
}

export class StateTransportService extends Context.Tag("StateTransport")<
	StateTransportService,
	StateTransport
>() {}
