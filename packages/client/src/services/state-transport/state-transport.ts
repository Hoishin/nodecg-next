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

export class TopicPublishFailed extends Data.TaggedError("TopicPublishFailed")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Failed to publish topic "${this.name}" in "${this.namespace}": ${this.cause.message}`;
}

export class RpcCallFailed extends Data.TaggedError("RpcCallFailed")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `RPC call "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
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
	publishTopic: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<
		void,
		StateNotFound | StatePermissionDenied | TopicPublishFailed
	>;
	callRpc: (
		namespace: string,
		name: string,
		request: JsonValue,
	) => Effect.Effect<
		JsonValue,
		StateNotFound | StatePermissionDenied | RpcCallFailed
	>;
}

export class StateTransportService extends Context.Tag("StateTransport")<
	StateTransportService,
	StateTransport
>() {}
