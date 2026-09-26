import { Context, type Effect, Schema } from "effect";

export class ReplicantNotFound extends Schema.TaggedError<ReplicantNotFound>()(
	"ReplicantNotFound",
	{ namespace: Schema.String, name: Schema.String },
) {
	override readonly message = `Replicant "${this.name}" in "${this.namespace}" does not exist`;
}

export class DecodeError extends Schema.TaggedError<DecodeError>()(
	"DecodeError",
	{ issue: Schema.String },
) {
	override readonly message = `Stored value does not decode: ${this.issue}`;
}

export class BackendError extends Schema.TaggedError<BackendError>()(
	"BackendError",
	{ cause: Schema.Defect() },
) {
	override readonly message = "Persistence backend failed";
}

/**
 * ReplicantStorage is platform-agnostic layer to persist replicant values.
 */
export interface ReplicantStorage {
	read: (
		namespace: string,
		name: string,
	) => Effect.Effect<
		Schema.Json,
		ReplicantNotFound | DecodeError | BackendError
	>;

	write: (
		namespace: string,
		name: string,
		value: Schema.Json,
	) => Effect.Effect<void, BackendError>;
}

export class ReplicantStorageService extends Context.Service<
	ReplicantStorageService,
	ReplicantStorage
>()("ReplicantStorage") {}
