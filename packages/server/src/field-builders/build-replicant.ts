import type { FieldManifest } from "@nodecg/core";
import { toError } from "@nodecg/internal/utils";
import { Data, Effect, Stream } from "effect";
import type { JsonValue } from "type-fest";

import { DerivationEngineService } from "../derivation-graph.ts";
import { ReplicantStorageService } from "../services/replicant-storage/replicant-storage.ts";
import { fieldInternal } from "./field-internal-key.ts";
import { migrationDie } from "./migration-die.ts";
import { requirePermission } from "./permission.ts";

export class ReplicantUpdateFnError extends Data.TaggedError(
	"ReplicantUpdateFnError",
)<{
	namespace: string;
	name: string;
	cause: Error;
}> {
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

	const getEncodedNoAuth = Effect.fn("getEncodedNoAuth")(function* () {
		return yield* engine.readReplicant(namespace, name);
	});

	const getEncoded = Effect.fn("getEncoded")(function* () {
		yield* requirePermission(manifest.permission, namespace, name, "read");
		return yield* getEncodedNoAuth();
	});

	const set = Effect.fn("set")(function* (value: Decoded) {
		yield* requirePermission(manifest.permission, namespace, name, "write");
		const storage = yield* ReplicantStorageService;
		const encoded = yield* manifest.encode(value);
		yield* storage.update(namespace, name, encoded);
		yield* engine.setReplicant(namespace, name, encoded);
	});

	const setEncoded = Effect.fn("setEncoded")(function* (value: JsonValue) {
		yield* requirePermission(manifest.permission, namespace, name, "write");
		const storage = yield* ReplicantStorageService;
		yield* manifest.decode(value); // Only for validation
		yield* storage.update(namespace, name, value);
		yield* engine.setReplicant(namespace, name, value);
	});

	const update = Effect.fn("update")(function* (
		fn: (value: Decoded) => Decoded,
	) {
		yield* requirePermission(manifest.permission, namespace, name, "write");
		const current = yield* get();
		const next = yield* Effect.try({
			try: () => fn(current),
			catch: (error) =>
				new ReplicantUpdateFnError({
					namespace,
					name,
					cause: toError(error),
				}),
		});
		const encoded = yield* manifest.encode(next);
		const storage = yield* ReplicantStorageService;
		yield* storage.update(namespace, name, encoded);
		yield* engine.setReplicant(namespace, name, encoded);
	});

	const subscribeEncoded = Effect.fn("subscribeEncoded")(function* () {
		const storage = yield* ReplicantStorageService;
		const changesStream = yield* storage.subscribe();
		const replicantValueStream = changesStream.pipe(
			Stream.filter(
				(change) => change.namespace === namespace && change.name === name,
			),
			Stream.map((change) => change.value),
		);
		const initialValue = yield* getEncodedNoAuth();
		return Stream.concat(Stream.succeed(initialValue), replicantValueStream);
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
			getEncoded,
			setEncoded,
			subscribeEncoded,
			permission: manifest.permission,
		},
	};
});

export type ReplicantFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof buildReplicant<Decoded>>
>;
