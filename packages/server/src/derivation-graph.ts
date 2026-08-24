import type { FieldEncodeError } from "@nodecg/core";
import {
	applyPatch,
	ChangeOp,
	computeFingerprint,
	isDrift,
	type Patch,
	PatchNotApplicable,
	RevisionConflict,
} from "@nodecg/internal/occ";
import { setSignal, toError } from "@nodecg/internal/utils";
import {
	computed,
	effect,
	type ReadonlySignal,
	type Signal,
	signal,
} from "@preact/signals-core";
import {
	Array,
	Data,
	Effect,
	Either,
	Equal,
	Exit,
	Hash,
	HashMap,
	Mailbox,
	Option,
	PubSub,
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

export class CommitContended extends Schema.TaggedError<CommitContended>()(
	"CommitContended",
	{
		namespace: Schema.String,
		name: Schema.String,
	},
) {
	override readonly message = `Committing "${this.name}" in "${this.namespace}" lost a compare-and-swap to a concurrent write`;
}

interface LeafValue {
	readonly hash: number;
	readonly value: JsonValue;
	readonly revision: number;
}

export interface RevisionedValue {
	readonly value: JsonValue;
	readonly revision: number;
}

export interface ReplicantFrame {
	readonly value: JsonValue;
	readonly revision: number;
	readonly delta: Option.Option<{
		readonly ops: Array.NonEmptyReadonlyArray<ChangeOp>;
		readonly baseRevision: number;
		readonly hash: number;
	}>;
}

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

			const changes = yield* PubSub.unbounded<{
				readonly namespace: string;
				readonly name: string;
				readonly frame: ReplicantFrame;
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
						yield* setSignal(replicant, stored).pipe(
							Effect.withSpan("setSignal", { attributes: { namespace, name } }),
							Effect.orDie,
						);
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
					return { value: stored.value, revision: stored.revision };
				},
			);

			const finishCommit = (
				node: ReplicantNode,
				namespace: string,
				name: string,
				stored: LeafValue,
				frame: ReplicantFrame,
			) =>
				SynchronizedRef.modifyEffect(replicants, (map) =>
					Effect.gen(function* () {
						if (node.peek().revision !== stored.revision) {
							return yield* new CommitContended({ namespace, name });
						}
						yield* setSignal(
							node,
							makeLeafValue(frame.value, frame.revision),
						).pipe(
							Effect.withSpan("setSignal", { attributes: { namespace, name } }),
							Effect.orDie,
						);
						yield* Queue.offer(pendingWrites, {
							namespace,
							name,
							value: frame.value,
						});
						yield* PubSub.publish(changes, { namespace, name, frame });
						return [
							{ value: frame.value, revision: frame.revision },
							map,
						] as const;
					}),
				);

			const commit = Effect.fn("DerivationEngine.commit")(function* <E>(
				namespace: string,
				name: string,
				produce: (current: RevisionedValue) => Effect.Effect<JsonValue, E>,
			) {
				// TODO: Make sure preconditions here are safe to run outside the lock
				const node = yield* lookupNode(namespace, name);
				const stored = node.peek();
				const nextEncoded = yield* produce({
					value: stored.value,
					revision: stored.revision,
				});
				if (sameValue(stored, nextEncoded)) {
					return { value: stored.value, revision: stored.revision };
				}
				return yield* finishCommit(node, namespace, name, stored, {
					value: nextEncoded,
					revision: stored.revision + 1,
					delta: Option.none(),
				});
			});

			const isChangeOp = Schema.is(ChangeOp);

			const commitPatch = Effect.fn("DerivationEngine.commitPatch")(function* <
				E,
			>(
				namespace: string,
				name: string,
				patch: Patch,
				validate: (applied: JsonValue) => Effect.Effect<unknown, E>,
			) {
				// TODO: Make sure preconditions here are safe to run outside the lock
				const node = yield* lookupNode(namespace, name);
				const stored = node.peek();
				const applied = applyPatch(stored.value, patch);
				if (Either.isLeft(applied)) {
					const { op, cause } = applied.left;
					if (isDrift(cause)) {
						return yield* new RevisionConflict({
							value: stored.value,
							revision: stored.revision,
							reason: cause._tag,
						});
					}
					return yield* new PatchNotApplicable({
						path: op.path,
						reason: cause._tag,
					});
				}
				const changeOps = patch.filter(isChangeOp);
				if (
					!Array.isNonEmptyReadonlyArray(changeOps) ||
					sameValue(stored, applied.right)
				) {
					return { value: stored.value, revision: stored.revision };
				}
				yield* validate(applied.right);
				return yield* finishCommit(node, namespace, name, stored, {
					value: applied.right,
					revision: stored.revision + 1,
					delta: Option.some({
						ops: changeOps,
						baseRevision: stored.revision,
						hash: computeFingerprint(applied.right),
					}),
				});
			});

			const subscribeReplicant = Effect.fn(
				"DerivationEngine.subscribeReplicant",
			)(function* (namespace: string, name: string) {
				const dequeue = yield* PubSub.subscribe(changes);
				const node = yield* lookupNode(namespace, name);
				const stored = yield* readLeaf(node, namespace, name);
				const seed: ReplicantFrame = {
					value: stored.value,
					revision: stored.revision,
					delta: Option.none(),
				};
				const updates = Stream.fromQueue(dequeue).pipe(
					Stream.filter(
						(event) =>
							event.namespace === namespace &&
							event.name === name &&
							event.frame.revision > stored.revision,
					),
					Stream.map((event) => event.frame),
				);
				return Stream.concat(Stream.succeed(seed), updates);
			});

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
				commit,
				commitPatch,
				subscribeReplicant,
				initializeComputed,
				readComputed,
				subscribeComputed,
			};
		}),
	},
) {}
