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
	Cause,
	Data,
	Effect,
	Equal,
	Exit,
	Hash,
	HashMap,
	Mailbox,
	Option,
	Ref,
	Runtime,
	Schema,
	SynchronizedRef,
} from "effect";
import type { JsonValue } from "type-fest";

import type { ReplicantNotFound } from "./services/replicant-storage/replicant-storage.ts";

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

const readSignal = <T>(
	signal: ReadonlySignal<T>,
	meta: {
		namespace: string;
		name: string;
	},
) =>
	Effect.try({
		try: () => signal.value,
		catch: (cause) =>
			new DerivationReadValueError({
				namespace: meta.namespace,
				name: meta.name,
				cause: toError(cause),
			}),
	}).pipe(Effect.orDie);

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

export class ReplicantNotFound2 extends Schema.TaggedError<ReplicantNotFound2>()(
	"ReplicantNotFound2",
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

interface StoredValue {
	hash: number;
	value: JsonValue;
}

// Cheap hash for quick deduplication, can collide
const makeStoredValue = (value: JsonValue): StoredValue => ({
	hash: Hash.string(JSON.stringify(value)),
	value,
});

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
		effect: Effect.gen(function* () {
			const runtime = yield* Effect.runtime<never>();
			const replicants = yield* SynchronizedRef.make(
				HashMap.empty<FieldKey, Signal<StoredValue>>(),
			);
			const computedResults = yield* SynchronizedRef.make(
				HashMap.empty<FieldKey, ReadonlySignal<ComputedResult>>(),
			);

			const initializeReplicant = Effect.fn(
				"DerivationEngine.initializeReplicant",
			)((namespace: string, name: string, value: JsonValue) =>
				SynchronizedRef.updateEffect(
					replicants,
					Effect.fnUntraced(function* (map) {
						const key = fieldKey(namespace, name);
						if (HashMap.has(map, key)) {
							return yield* new ReplicantAlreadyRegistered({ namespace, name });
						}
						const stored = makeStoredValue(value);
						const replicant = signal(stored);
						yield* setSignal(replicant, stored, { namespace, name });
						return HashMap.set(map, key, replicant);
					}),
				),
			);

			const readReplicant = Effect.fn("DerivationEngine.readReplicant")(
				function* (namespace: string, name: string) {
					const map = yield* Ref.get(replicants);
					const key = fieldKey(namespace, name);
					const existing = HashMap.get(map, key);
					if (Option.isNone(existing)) {
						return yield* new ReplicantNotFound2({ namespace, name });
					}
					const replicant = yield* readSignal(existing.value, {
						namespace,
						name,
					});
					return replicant.value;
				},
			);

			const setReplicant = Effect.fn("DerivationEngine.setReplicant")(
				function* (namespace: string, name: string, value: JsonValue) {
					const map = yield* Ref.get(replicants);
					const key = fieldKey(namespace, name);
					const existing = HashMap.get(map, key);
					if (Option.isNone(existing)) {
						return yield* new ReplicantNotFound2({ namespace, name });
					}
					const current = yield* readSignal(existing.value, {
						namespace,
						name,
					});
					const newReplicant = makeStoredValue(value);
					if (
						current.hash !== newReplicant.hash ||
						JSON.stringify(current.value) !== JSON.stringify(newReplicant.value)
					) {
						yield* setSignal(existing.value, newReplicant, { namespace, name });
					}
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
					const stored = yield* readSignal(existing.value, { namespace, name });
					return yield* stored; // Unwrap the Exit
				},
			);

			// TODO: apply refactors to other methods
			const subscribeComputed = Effect.fn("DerivationEngine.subscribeComputed")(
				function* (namespace: string, name: string) {
					const result = Option.getOrUndefined(
						HashMap.get(
							yield* Ref.get(computedResults),
							fieldKey(namespace, name),
						),
					);
					if (typeof result === "undefined") {
						return yield* Effect.die(
							new Error(`Computed "${namespace}/${name}" is not registered`),
						);
					}
					const mailbox = yield* Mailbox.make<JsonValue>();
					yield* Effect.acquireRelease(
						Effect.sync(() =>
							effect(() =>
								Runtime.runSync(
									runtime,
									Effect.gen(function* () {
										// Reading value can throw with circular dependencies
										const evaluation = yield* Effect.try({
											try: () => result.value,
											catch: (cause) =>
												new ComputedComputeError({
													namespace,
													name,
													cause: toError(cause),
												}),
										});
										yield* Exit.match(evaluation, {
											onFailure: (cause) =>
												Effect.logError(
													`Failed to compute "${namespace}/${name}"`,
													Cause.squash(cause),
												),
											onSuccess: (encoded) => mailbox.offer(encoded),
										});
									}).pipe(
										Effect.catchTag("ComputedComputeError", (error) =>
											Effect.logError(
												`Failed to compute "${namespace}/${name}"`,
												error,
											),
										),
									),
								),
							),
						),
						(dispose) => Effect.sync(dispose),
					);
					return Mailbox.toStream(mailbox);
				},
			);

			return {
				initializeReplicant,
				readReplicant,
				setReplicant,
				initializeComputed,
				readComputed,
				subscribeComputed,
			};
		}),
	},
) {}
