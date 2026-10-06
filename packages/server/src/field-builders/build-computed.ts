import type { FieldManifest } from "@nodecg-next/core";
import { Effect, Stream } from "effect";

import {
	ComputedComputeError,
	ReplicantStoreService,
} from "../replicant-store.ts";
import type { ReplicantNotFound } from "../services/repository/replicant/replicant-repository.ts";
import { fieldInternal } from "./field-internal-key.ts";
import { migrationDie } from "./migration-die.ts";
import { requirePermission } from "./permission.ts";

export const buildComputed = Effect.fn("buildComputed")(function* <Decoded>(
	namespace: string,
	name: string,
	manifest: FieldManifest<Decoded>,
	computeValue: Effect.Effect<
		Decoded,
		ComputedComputeError | ReplicantNotFound,
		ReplicantStoreService
	>,
) {
	const computeEncoded = Effect.fn("computeEncoded")(function* () {
		const value = yield* computeValue;
		return yield* manifest.encode(value);
	});

	const store = yield* ReplicantStoreService;
	yield* store.initializeComputed(namespace, name, () =>
		Effect.runSyncExit(
			computeEncoded().pipe(
				Effect.provideService(ReplicantStoreService, store),
			),
		),
	);

	const get = Effect.fn("get")(function* () {
		yield* requirePermission(manifest.permission, namespace, name, "read");
		const encoded = yield* store.readComputed(namespace, name);
		return yield* manifest.decode(encoded);
	});

	const getEncodedNoAuth = Effect.fn("getEncodedNoAuth")(function* () {
		return yield* store.readComputed(namespace, name);
	});

	const getEncoded = Effect.fn("getEncoded")(function* () {
		yield* requirePermission(manifest.permission, namespace, name, "read");
		return yield* store.readComputed(namespace, name);
	});

	const subscribeEncoded = Effect.fn("subscribeEncoded")(function* () {
		return yield* store.subscribeComputed(namespace, name);
	});

	const subscribe = Effect.fn("subscribe")(function* () {
		const stream = yield* subscribeEncoded();
		return stream.pipe(
			Stream.mapEffect((value) => manifest.decode(value).pipe(migrationDie)),
		);
	});

	return {
		get,
		subscribe,
		[fieldInternal]: {
			get,
			subscribe,
			getEncodedNoAuth,
			getEncoded,
			subscribeEncoded,
			permission: manifest.permission,
		},
	};
});

export type ComputedFieldEffect<Decoded> = Effect.Success<
	ReturnType<typeof buildComputed<Decoded>>
>;
