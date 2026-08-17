import type { FieldEncodeError } from "@nodecg/core";
import { toError } from "@nodecg/internal/utils";
import {
	computed,
	effect,
	type ReadonlySignal,
	type Signal,
	signal,
} from "@preact/signals-core";
import {
	Data,
	Effect,
	Equal,
	Exit,
	Hash,
	HashMap,
	Mailbox,
	Option,
	Queue,
	Ref,
	Runtime,
	Schema,
	Stream,
	SynchronizedRef,
} from "effect";
import type { JsonValue } from "type-fest";

import {
	type ReplicantNotFound,
	ReplicantStorageService,
} from "./services/replicant-storage/replicant-storage.ts";

export class ComputedComputeError extends Schema.TaggedError<ComputedComputeError>()(
	"ComputedComputeError",
	{
		namespace: Schema.String,
		name: Schema.String,
		cause: Schema.instanceOf(Error),
	},
) {
	override readonly message = `Computing computed field "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

export class ReplicantAlreadyRegistered extends Schema.TaggedError<ReplicantAlreadyRegistered>()(
	"ReplicantAlreadyRegistered",
	{
		namespace: Schema.String,
		name: Schema.String,
	},
) {
	override readonly message = `Replicant "${this.name}" in "${this.namespace}" is already registered`;
}

export class ComputedAlreadyRegistered extends Schema.TaggedError<ComputedAlreadyRegistered>()(
	"ComputedAlreadyRegistered",
	{
		namespace: Schema.String,
		name: Schema.String,
	},
) {
	override readonly message = `Computed "${this.name}" in "${this.namespace}" is already registered`;
}

const fieldKey = (namespace: string, name: string) =>
	Data.struct({ namespace, name });
type FieldKey = ReturnType<typeof fieldKey>;

export class DerivationReadValueError extends Schema.TaggedError<DerivationReadValueError>()(
	"DerivationReadValueError",
	{
		namespace: Schema.String,
		name: Schema.String,
		cause: Schema.instanceOf(Error),
	},
) {
	override readonly message = `Reading value for "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

const readSignal = <T>(signal: ReadonlySignal<T>) =>
	Effect.try(() => signal.value);

export class DerivationSetValueError extends Schema.TaggedError<DerivationSetValueError>()(
	"DerivationSetValueError",
	{
		namespace: Schema.String,
		name: Schema.String,
		cause: Schema.instanceOf(Error),
	},
) {
	override readonly message = `Setting value for "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

const setSignal = <T>(
	signal: Signal<T>,
	value: T,
	meta: {
		namespace: string;
		name: string;
	},
) =>
	Effect.try({
		try: () => {
			signal.value = value;
		},
		catch: (cause) =>
			new DerivationSetValueError({
				namespace: meta.namespace,
				name: meta.name,
				cause: toError(cause),
			}),
	}).pipe(Effect.orDie);

export class UnknownReplicant extends Schema.TaggedError<UnknownReplicant>()(
	"UnknownReplicant",
	{
		namespace: Schema.String,
		name: Schema.String,
	},
) {
	override readonly message = `Replicant "${this.name}" in "${this.namespace}" does not exist`;
}

export class ComputedNotFound extends Schema.TaggedError<ComputedNotFound>()(
	"ComputedNotFound",
	{
		namespace: Schema.String,
		name: Schema.String,
	},
) {
	override readonly message = `Computed "${this.name}" in "${this.namespace}" does not exist`;
}

interface LeafValue {
	hash: number;
	value: JsonValue;
	revision: number;
}

export type ReplicantFrame = {
	readonly kind: "snapshot";
	readonly value: JsonValue;
	readonly revision: number;
};

// Cheap hash for quick deduplication, can collide
const makeLeafValue = (value: JsonValue, revision: number): LeafValue => ({
	hash: Hash.string(JSON.stringify(value)),
	value,
	revision,
});

const sameValue = (current: LeafValue, value: JsonValue) => {
	const serialized = JSON.stringify(value);
	return (
		current.hash === Hash.string(serialized) &&
		JSON.stringify(current.value) === serialized
	);
};

type ReplicantNode = Signal<LeafValue>;

export type ComputedResult = Exit.Exit<
	JsonValue,
	ComputedComputeError | ReplicantNotFound | FieldEncodeError
>;

/**
 * Implements `computed` reactivity with signals
 */
export class DerivationEngineService extends Effect.Service<DerivationEngineService>()(
	"DerivationEngine",
	{
		scoped: Effect.gen(function* () {
			const runtime = yield* Effect.runtime<never>();
			const storage = yield* ReplicantStorageService;
			const replicants = yield* SynchronizedRef.make(
				HashMap.empty<FieldKey, ReplicantNode>(),
			);
			const computedResults = yield* SynchronizedRef.make(
				HashMap.empty<FieldKey, ReadonlySignal<ComputedResult>>(),
			);

			const pendingWrites = yield* Queue.unbounded<{
				readonly namespace: string;
				readonly name: string;
				readonly value: JsonValue;
			}>();

			const initializeReplicant = Effect.fn(
				"DerivationEngine.initializeReplicant",
			)(function* (namespace: string, name: string, seed: JsonValue) {
				const persisted = yield* storage.read(namespace, name).pipe(
					Effect.asSome,
					Effect.catchTag("ReplicantNotFound", () => Effect.succeedNone),
				);
				const initial = Option.getOrElse(persisted, () => seed);
				yield* SynchronizedRef.updateEffect(replicants, (map) =>
					Effect.gen(function* () {
						const key = fieldKey(namespace, name);
						if (HashMap.has(map, key)) {
							return yield* new ReplicantAlreadyRegistered({ namespace, name });
						}
						const stored = makeLeafValue(initial, 0);
						const replicant = signal(stored);
						yield* setSignal(replicant, stored, { namespace, name });
						return HashMap.set(map, key, replicant);
					}),
				);
				if (Option.isNone(persisted)) {
					yield* storage.write(namespace, name, seed, true);
				}
			});

			const lookupNode = Effect.fn(function* (namespace: string, name: string) {
				const map = yield* Ref.get(replicants);
				const existing = HashMap.get(map, fieldKey(namespace, name));
				if (Option.isNone(existing)) {
					return yield* new UnknownReplicant({ namespace, name });
				}
				return existing.value;
			});

			const readLeaf = (node: ReplicantNode, namespace: string, name: string) =>
				readSignal(node).pipe(
					Effect.orDieWith(
						(cause) =>
							new DerivationReadValueError({
								namespace,
								name,
								cause: toError(cause.error),
							}),
					),
				);

			const persist = (namespace: string, name: string, value: JsonValue) =>
				storage
					.write(namespace, name, value)
					.pipe(
						Effect.catchAll((error) =>
							Effect.logError(
								`Persisting replicant "${namespace}/${name}" failed`,
								error,
							),
						),
					);

			yield* Effect.addFinalizer(() =>
				Effect.gen(function* () {
					const map = yield* Ref.get(replicants);
					yield* Effect.forEach(HashMap.toEntries(map), ([key, node]) =>
						readLeaf(node, key.namespace, key.name).pipe(
							Effect.flatMap((stored) =>
								persist(key.namespace, key.name, stored.value),
							),
						),
					);
				}),
			);

			yield* Effect.forkScoped(
				Stream.runForEach(Stream.fromQueue(pendingWrites), (write) =>
					persist(write.namespace, write.name, write.value),
				),
			);

			const readReplicant = Effect.fn("DerivationEngine.readReplicant")(
				function* (namespace: string, name: string) {
					const node = yield* lookupNode(namespace, name);
					const stored = yield* readLeaf(node, namespace, name);
					return stored.value;
				},
			);

			const readRevisioned = Effect.fn("DerivationEngine.readRevisioned")(
				function* (namespace: string, name: string) {
					const node = yield* lookupNode(namespace, name);
					const stored = yield* readLeaf(node, namespace, name);
					return { value: stored.value, revision: stored.revision };
				},
			);

			// Last write wins
			const commitValue = Effect.fn("DerivationEngine.commitValue")(function* (
				namespace: string,
				name: string,
				nextEncoded: JsonValue,
			) {
				return yield* SynchronizedRef.modifyEffect(replicants, (map) =>
					Effect.gen(function* () {
						const existing = HashMap.get(map, fieldKey(namespace, name));
						if (Option.isNone(existing)) {
							return yield* new UnknownReplicant({ namespace, name });
						}
						const node = existing.value;
						const stored = yield* readLeaf(node, namespace, name);
						if (sameValue(stored, nextEncoded)) {
							return [
								{ value: stored.value, revision: stored.revision },
								map,
							] as const;
						}
						const revision = stored.revision + 1;
						yield* setSignal(node, makeLeafValue(nextEncoded, revision), {
							namespace,
							name,
						});
						yield* Queue.offer(pendingWrites, {
							namespace,
							name,
							value: nextEncoded,
						});
						return [{ value: nextEncoded, revision }, map] as const;
					}),
				);
			});

			const subscribeValues = Effect.fn("DerivationEngine.subscribeValues")(
				function* (namespace: string, name: string) {
					const node = yield* lookupNode(namespace, name);
					const values = yield* Queue.unbounded<JsonValue>();
					// The effect runs on arm, so the current value is the stream's first
					// element and no write can slip between reading the seed and watching.
					yield* Effect.acquireRelease(
						Effect.sync(() =>
							effect(() => {
								const stored = node.value;
								Queue.unsafeOffer(values, stored.value);
							}),
						),
						(dispose) => Effect.sync(dispose),
					);
					return Stream.fromQueue(values);
				},
			);

			const initializeComputed = Effect.fn(
				"DerivationEngine.initializeComputed",
			)((namespace: string, name: string, evaluate: () => ComputedResult) =>
				SynchronizedRef.updateEffect(computedResults, (map) =>
					Effect.gen(function* () {
						const key = fieldKey(namespace, name);
						if (HashMap.has(map, key)) {
							return yield* new ComputedAlreadyRegistered({ namespace, name });
						}

						let last: ComputedResult | undefined;
						let lastHash: number | undefined;
						const result = computed(() => {
							return Exit.match(evaluate(), {
								onSuccess: (value) => {
									const hash = Hash.string(JSON.stringify(value));
									if (
										typeof last === "undefined" ||
										!Exit.isSuccess(last) ||
										lastHash !== hash ||
										JSON.stringify(value) !== JSON.stringify(last.value)
									) {
										last = Exit.succeed(value);
										lastHash = hash;
									}
									return last;
								},
								onFailure: (cause) => {
									if (
										typeof last === "undefined" ||
										!Exit.isFailure(last) ||
										!Equal.equals(cause, last.cause)
									) {
										last = Exit.failCause(cause);
										lastHash = undefined;
									}
									return last;
								},
							});
						});
						return HashMap.set(map, key, result);
					}),
				),
			);

			const readComputed = Effect.fn("DerivationEngine.readComputed")(
				function* (namespace: string, name: string) {
					const map = yield* Ref.get(computedResults);
					const existing = HashMap.get(map, fieldKey(namespace, name));
					if (Option.isNone(existing)) {
						return yield* new ComputedNotFound({ namespace, name });
					}
					const stored = yield* readSignal(existing.value).pipe(
						Effect.orDieWith(
							(cause) =>
								new DerivationReadValueError({
									namespace,
									name,
									cause: toError(cause.error),
								}),
						),
					);
					return yield* stored; // Unwrap the Exit
				},
			);

			const subscribeComputed = Effect.fn("DerivationEngine.subscribeComputed")(
				function* (namespace: string, name: string) {
					const result = Option.getOrUndefined(
						HashMap.get(
							yield* Ref.get(computedResults),
							fieldKey(namespace, name),
						),
					);
					if (typeof result === "undefined") {
						return yield* new ComputedNotFound({ namespace, name });
					}
					const mailbox = yield* Mailbox.make<JsonValue>();
					const readNode = Effect.gen(function* () {
						const evaluation = yield* readSignal(result).pipe(
							Effect.mapError(
								(cause) =>
									new ComputedComputeError({
										namespace,
										name,
										cause: toError(cause.error),
									}),
							),
						);
						return yield* evaluation;
					});
					yield* Effect.acquireRelease(
						Effect.sync(() =>
							effect(() =>
								Runtime.runSync(
									runtime,
									readNode.pipe(
										Effect.flatMap((encoded) => mailbox.offer(encoded)),
										Effect.catchAll((error) =>
											Effect.logError(
												`Failed to compute "${namespace}/${name}"`,
												error,
											),
										),
										Effect.asVoid,
									),
								),
							),
						),
						(dispose) => Effect.sync(dispose),
					);
					// Gate: reject the subscribe if the current value can't be produced.
					yield* readNode;
					return Mailbox.toStream(mailbox);
				},
			);

			return {
				initializeReplicant,
				readReplicant,
				readRevisioned,
				commitValue,
				subscribeValues,
				initializeComputed,
				readComputed,
				subscribeComputed,
			};
		}),
	},
) {}
