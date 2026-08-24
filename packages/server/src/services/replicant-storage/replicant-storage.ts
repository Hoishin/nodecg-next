import { Context, type Effect, Schema } from "effect";
import type { JsonValue } from "type-fest";

export class ReplicantNotFound extends Schema.TaggedError<ReplicantNotFound>()(
	"ReplicantNotFound",
	{ namespace: Schema.String, name: Schema.String },
) {
	override readonly message = `Replicant "${this.name}" in "${this.namespace}" does not exist`;
}

/**
 * ReplicantStorage is platform-agnostic layer to persist replicant values.
 */
export interface ReplicantStorage {
	read: (
		namespace: string,
		name: string,
	) => Effect.Effect<JsonValue, ReplicantNotFound>;

	write: (
		namespace: string,
		name: string,
		value: JsonValue,
		createIfNotFound?: boolean,
	) => Effect.Effect<void, ReplicantNotFound>;
}

export class ReplicantStorageService extends Context.Tag("ReplicantStorage")<
	ReplicantStorageService,
	ReplicantStorage
>() {}
