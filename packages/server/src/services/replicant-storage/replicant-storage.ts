import { Context, type Effect, Schema, type Scope, type Stream } from "effect";
import type { JsonValue } from "type-fest";

export interface ReplicantChange {
	readonly namespace: string;
	readonly name: string;
	readonly value: JsonValue;
}

export class ReplicantNotFound extends Schema.TaggedError<ReplicantNotFound>()(
	"ReplicantNotFound",
	{ namespace: Schema.String, name: Schema.String },
) {
	override readonly message = `Replicant "${this.name}" in "${this.namespace}" does not exist`;
}

export class ReplicantPersistError extends Schema.TaggedError<ReplicantPersistError>()(
	"ReplicantPersistError",
	{ cause: Schema.instanceOf(Error) },
) {
	override readonly message = `Failed to persist replicant: ${this.cause.message}`;
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

	subscribe: () => Effect.Effect<
		Stream.Stream<ReplicantChange>,
		never,
		Scope.Scope
	>;

	flush: () => Effect.Effect<void, ReplicantPersistError>;
}

export class ReplicantStorageService extends Context.Tag("ReplicantStorage")<
	ReplicantStorageService,
	ReplicantStorage
>() {}
