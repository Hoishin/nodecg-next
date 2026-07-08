import {
	Context,
	Data,
	type Effect,
	type Option,
	type Scope,
	type Stream,
} from "effect";
import type { JsonValue } from "type-fest";

export interface ReplicantChange {
	readonly namespace: string;
	readonly name: string;
	readonly value: JsonValue;
}

export class ReplicantNotFound extends Data.TaggedError("ReplicantNotFound")<{
	namespace: string;
	name: string;
}> {
	override readonly message = `Replicant "${this.name}" in "${this.namespace}" does not exist`;
}

export class ReplicantAlreadyExists extends Data.TaggedError(
	"ReplicantAlreadyExists",
)<{
	namespace: string;
	name: string;
}> {
	override readonly message = `Replicant "${this.name}" in "${this.namespace}" already exists`;
}

export class ReplicantPersistError extends Data.TaggedError(
	"ReplicantPersistError",
)<{
	cause: Error;
}> {
	override readonly message = `Failed to persist replicant: ${this.cause.message}`;
}

/**
 * ReplicantStorage is platform-agnostic layer to persist replicant values.
 */
export interface ReplicantStorage {
	/**
	 * Create a new replicant entry in storage. Must supply valid initial value.
	 */
	create: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<void, ReplicantAlreadyExists>;

	/**
	 * Read the current in-memory value synchronously.
	 */
	read: (namespace: string, name: string) => Option.Option<JsonValue>;

	/**
	 * Update the already-existing replicant value with a new value
	 */
	update: (
		namespace: string,
		name: string,
		value: JsonValue,
	) => Effect.Effect<void, ReplicantNotFound>;

	/**
	 * Subscribe to changes. Returns one stream that contains all changes.
	 */
	subscribe: () => Effect.Effect<
		Stream.Stream<ReplicantChange>,
		never,
		Scope.Scope
	>;

	/**
	 * Force a durable write of all pending in-memory replicant and confirm it.
	 */
	flush: () => Effect.Effect<void, ReplicantPersistError>;
}

export class ReplicantStorageService extends Context.Tag("ReplicantStorage")<
	ReplicantStorageService,
	ReplicantStorage
>() {}
