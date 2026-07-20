import { Context, type Effect, Schema } from "effect";
import type { JsonValue } from "type-fest";

export class FieldNotFound extends Schema.TaggedError<FieldNotFound>()(
	"FieldNotFound",
	{ namespace: Schema.String, name: Schema.String },
) {
	override readonly message = `Field "${this.name}" in "${this.namespace}" does not exist`;
}

export class FieldPermissionDenied extends Schema.TaggedError<FieldPermissionDenied>()(
	"FieldPermissionDenied",
	{ namespace: Schema.String, name: Schema.String },
) {
	override readonly message = `Permission denied for "${this.name}" in "${this.namespace}"`;
}

export class FieldUnavailable extends Schema.TaggedError<FieldUnavailable>()(
	"FieldUnavailable",
	{
		namespace: Schema.String,
		name: Schema.String,
		detail: Schema.optional(Schema.String),
	},
) {
	override readonly message = `Field "${this.name}" in "${this.namespace}" is currently unavailable${
		typeof this.detail === "undefined" ? "" : `: ${this.detail}`
	}`;
}

export class FieldGetError extends Schema.TaggedError<FieldGetError>()(
	"FieldGetError",
	{
		namespace: Schema.String,
		name: Schema.String,
		cause: Schema.instanceOf(Error),
	},
) {
	override readonly message = `Failed to get field "${this.name}" in "${this.namespace}": ${this.cause.message}`;
}

export class FieldSetError extends Schema.TaggedError<FieldSetError>()(
	"FieldSetError",
	{
		namespace: Schema.String,
		name: Schema.String,
		cause: Schema.instanceOf(Error),
	},
) {
	override readonly message = `Failed to set field "${this.name}" in "${this.namespace}": ${this.cause.message}`;
}

export class TopicPublishError extends Schema.TaggedError<TopicPublishError>()(
	"TopicPublishError",
	{
		namespace: Schema.String,
		name: Schema.String,
		cause: Schema.instanceOf(Error),
	},
) {
	override readonly message = `Failed to publish topic "${this.name}" in "${this.namespace}": ${this.cause.message}`;
}

export class RpcCallError extends Schema.TaggedError<RpcCallError>()(
	"RpcCallError",
	{
		namespace: Schema.String,
		name: Schema.String,
		cause: Schema.instanceOf(Error),
	},
) {
	override readonly message = `RPC call "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

export interface FieldTransport {
	getReplicant: (
		namespace: string,
		name: string,
	) => Effect.Effect<
		JsonValue,
		FieldNotFound | FieldPermissionDenied | FieldGetError
	>;
	getComputed: (
		namespace: string,
		name: string,
	) => Effect.Effect<
		JsonValue,
		FieldNotFound | FieldPermissionDenied | FieldGetError
	>;
	setReplicant: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<
		void,
		FieldNotFound | FieldPermissionDenied | FieldSetError
	>;
	publishTopic: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<
		void,
		FieldNotFound | FieldPermissionDenied | TopicPublishError
	>;
	callRpc: (
		namespace: string,
		name: string,
		request: JsonValue,
	) => Effect.Effect<
		JsonValue,
		FieldNotFound | FieldPermissionDenied | RpcCallError
	>;
}

export class FieldTransportService extends Context.Tag("FieldTransport")<
	FieldTransportService,
	FieldTransport
>() {}
