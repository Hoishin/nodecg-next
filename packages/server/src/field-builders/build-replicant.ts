import type { FieldManifest } from "@nodecg/core";
import type { Updater } from "@nodecg/internal";
import { toError } from "@nodecg/internal/utils";
import { Effect, Schema, Stream } from "effect";
import type { JsonValue } from "type-fest";

import { DerivationEngineService } from "../derivation-graph.ts";
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

	const get = Effect.fn("get")(function* () {
		yield* requirePermission(manifest.permission, namespace, name, "read");
		const engine = yield* DerivationEngineService;
		const encoded = yield* engine.readReplicant(namespace, name);
		return yield* manifest.decode(encoded).pipe(migrationDie);
	});

	const getRevisioned = Effect.fn("getRevisioned")(function* () {
		yield* requirePermission(manifest.permission, namespace, name, "read");
		return yield* engine.readRevisioned(namespace, name);
	});

	const set = Effect.fn("set")(function* (value: Decoded) {
		yield* requirePermission(manifest.permission, namespace, name, "write");
		const encoded = yield* manifest.encode(value);
		yield* engine.commitValue(namespace, name, encoded);
	});

	const setEncoded = Effect.fn("setEncoded")(function* (value: JsonValue) {
		yield* requirePermission(manifest.permission, namespace, name, "write");
		yield* manifest.decode(value); // Only for validation
		yield* engine.commitValue(namespace, name, value);
	});

	const update = Effect.fn("update")(function* (updater: Updater<Decoded>) {
		yield* requirePermission(manifest.permission, namespace, name, "write");
		const encoded = yield* engine.readReplicant(namespace, name);
		const current = yield* manifest.mutableDecode(encoded).pipe(migrationDie);
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
		const nextEncoded = yield* manifest.encode(next);
		yield* engine.commitValue(namespace, name, nextEncoded);
	});

	const subscribeEncoded = Effect.fn("subscribeEncoded")(function* () {
		return yield* engine.subscribeValues(namespace, name);
	});

	const subscribe = Effect.fn("subscribe")(function* () {
		const stream = yield* subscribeEncoded();
		return stream.pipe(
			Stream.flatMap((value) => manifest.decode(value).pipe(migrationDie)),
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
			setEncoded,
			subscribeEncoded,
			permission: manifest.permission,
		},
	};
});

export type ReplicantFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof buildReplicant<Decoded>>
>;
