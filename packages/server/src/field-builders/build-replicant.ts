import type { FieldManifest } from "@nodecg/core";
import type { Updater } from "@nodecg/internal";
import type { Patch } from "@nodecg/internal/occ";
import { toError } from "@nodecg/internal/utils";
import { Effect, Schema, Stream } from "effect";
import type { JsonValue } from "type-fest";

import {
	CommitContended,
	DerivationEngineService,
	type RevisionedValue,
} from "../derivation-graph.ts";
import { fieldInternal } from "./field-internal-key.ts";
import { migrationDie } from "./migration-die.ts";
import { requirePermission } from "./permission.ts";

export class ReplicantUpdateFnError extends Schema.TaggedError<ReplicantUpdateFnError>()(
	"ReplicantUpdateFnError",
	{
		namespace: Schema.String,
		name: Schema.String,
		cause: Schema.instanceOf(Error),
	},
) {
	override readonly message = `Update function for replicant "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

export const buildReplicant = Effect.fn("buildReplicant")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
	initialValue: Decoded,
) {
	const engine = yield* DerivationEngineService;

	yield* engine.initializeReplicant(
		namespace,
		name,
		yield* manifest.encode(initialValue),
	);

	const retryContention = <A, E, R>(
		attempt: Effect.Effect<A, E | CommitContended, R>,
	) =>
		attempt.pipe(
			Effect.retry({
				while: (error) => error instanceof CommitContended,
				times: 100,
			}),
			Effect.catchTag("CommitContended", () =>
				Effect.dieMessage(
					`Committing "${namespace}/${name}" lost 100 compare-and-swap attempts, is an updater writing its own field?`,
				),
			),
		);

	const commit = <E>(
		produce: (current: RevisionedValue) => Effect.Effect<JsonValue, E>,
	) => retryContention(engine.commit(namespace, name, produce));

	const get = Effect.fn("get")(function* () {
		yield* requirePermission(manifest.permission, namespace, name, "read");
		const engine = yield* DerivationEngineService;
		const { value } = yield* engine.readReplicant(namespace, name);
		return yield* manifest.decode(value).pipe(migrationDie);
	});

	const getRevisioned = Effect.fn("getRevisioned")(function* () {
		yield* requirePermission(manifest.permission, namespace, name, "read");
		return yield* engine.readReplicant(namespace, name);
	});

	const set = Effect.fn("set")(function* (value: Decoded) {
		yield* requirePermission(manifest.permission, namespace, name, "write");
		const encoded = yield* manifest.encode(value);
		yield* commit(() => Effect.succeed(encoded));
	});

	// Wire write: applies the client's patch, the decode gate validates the applied document
	const commitPatch = Effect.fn("commitPatch")(function* (patch: Patch) {
		yield* requirePermission(manifest.permission, namespace, name, "write");
		return yield* retryContention(
			engine.commitPatch(namespace, name, patch, manifest.decode),
		);
	});

	const update = Effect.fn("update")(function* (updater: Updater<Decoded>) {
		yield* requirePermission(manifest.permission, namespace, name, "write");
		yield* commit((stored) =>
			Effect.gen(function* () {
				const current = yield* manifest
					.mutableDecode(stored.value)
					.pipe(migrationDie);
				const next = yield* Effect.try({
					try: () => {
						const result = updater(current);
						if (typeof result === "undefined") {
							return current;
						}
						return result;
					},
					catch: (error) =>
						new ReplicantUpdateFnError({
							namespace,
							name,
							cause: toError(error),
						}),
				});
				return yield* manifest.encode(next);
			}),
		);
	});

	const subscribeRevisioned = Effect.fn("subscribeRevisioned")(function* () {
		return yield* engine.subscribeReplicant(namespace, name);
	});

	const subscribe = Effect.fn("subscribe")(function* () {
		const stream = yield* engine.subscribeReplicant(namespace, name);
		return stream.pipe(
			Stream.flatMap((frame) =>
				manifest.decode(frame.value).pipe(migrationDie),
			),
		);
	});

	return {
		get,
		set,
		update,
		validate: manifest.encode,
		subscribe,
		[fieldInternal]: {
			get,
			set,
			update,
			validate: manifest.encode,
			subscribe,
			getRevisioned,
			commitPatch,
			subscribeRevisioned,
			permission: manifest.permission,
		},
	};
});

export type ReplicantFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof buildReplicant<Decoded>>
>;
