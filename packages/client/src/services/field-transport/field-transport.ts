import { Context, Data, type Effect } from "effect";
import type { JsonValue } from "type-fest";

export class FieldNotFound extends Data.TaggedError("FieldNotFound")<{
	namespace: string;
	name: string;
}> {
	override readonly message = `Field "${this.name}" in "${this.namespace}" does not exist`;
}

export class FieldPermissionDenied extends Data.TaggedError(
	"FieldPermissionDenied",
)<{
	namespace: string;
	name: string;
}> {
	override readonly message = `Permission denied for "${this.name}" in "${this.namespace}"`;
}

export class FieldGetFailed extends Data.TaggedError("FieldGetFailed")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Failed to get field "${this.name}" in "${this.namespace}": ${this.cause.message}`;
}

export class FieldSaveFailed extends Data.TaggedError("FieldSaveFailed")<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Failed to save field "${this.name}" in "${this.namespace}": ${this.cause.message}`;
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

export interface FieldTransport {
	readState: (
		namespace: string,
		name: string,
	) => Effect.Effect<
		JsonValue,
		FieldNotFound | FieldPermissionDenied | FieldGetFailed
	>;
	readComputed: (
		namespace: string,
		name: string,
	) => Effect.Effect<
		JsonValue,
		FieldNotFound | FieldPermissionDenied | FieldGetFailed
	>;
	updateState: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<
		void,
		FieldNotFound | FieldPermissionDenied | FieldSaveFailed
	>;
	publishTopic: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<
		void,
		FieldNotFound | FieldPermissionDenied | TopicPublishFailed
	>;
	callRpc: (
		namespace: string,
		name: string,
		request: JsonValue,
	) => Effect.Effect<
		JsonValue,
		FieldNotFound | FieldPermissionDenied | RpcCallFailed
	>;
}

export class FieldTransportService extends Context.Tag("FieldTransport")<
	FieldTransportService,
	FieldTransport
>() {}
