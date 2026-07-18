import type { FieldManifest } from "@nodecg/core";
import { toError } from "@nodecg/internal/utils";
import { Data, Effect, Option, Stream } from "effect";
import type { JsonValue } from "type-fest";

import type { ComputeContext } from "../implement-namespace.ts";
import {
	ReplicantNotFound,
	ReplicantStorageService,
} from "../services/replicant-storage/replicant-storage.ts";
import { fieldInternal } from "./field-internal-key.ts";
import { migrationDie } from "./migration-die.ts";
import { requirePermission } from "./permission.ts";

export class ComputedComputeError extends Data.TaggedError(
	"ComputedComputeError",
)<{
	namespace: string;
	name: string;
	cause: Error;
}> {
	override readonly message = `Computing computed field "${this.name}" in "${this.namespace}" failed: ${this.cause.message}`;
}

export const buildComputed = Effect.fn("buildComputed")(
	<Decoded, Sources = never>(
		namespace: string,
		name: string,
		manifest: FieldManifest<Decoded>,
		compute: (sources: Sources, ctx: ComputeContext) => Decoded,
		readSnapshot: Effect.Effect<
			Sources,
			ReplicantNotFound,
			ReplicantStorageService
		>,
		computeContext: ComputeContext,
	) =>
		Effect.sync(() => {
			const computeValue = Effect.fn("compute")(function* () {
				const sources = yield* readSnapshot;
				return yield* Effect.try({
					try: () => compute(sources, computeContext),
					catch: (error) =>
						new ComputedComputeError({
							namespace,
							name,
							cause: toError(error),
						}),
				});
			});

			const get = Effect.fn("get")(function* () {
				yield* requirePermission(manifest.permission, namespace, name, "read");
				return yield* computeValue();
			});

			const getEncodedNoAuth = Effect.fn("getEncodedNoAuth")(function* () {
				const value = yield* computeValue();
				return yield* manifest.encode(value);
			});

			const getEncoded = Effect.fn("getEncoded")(function* () {
				yield* requirePermission(manifest.permission, namespace, name, "read");
				return yield* getEncodedNoAuth();
			});

			const subscribeEncoded = Effect.fn("subscribeEncoded")(function* () {
				const storage = yield* ReplicantStorageService;
				const changesStream = yield* storage.subscribe();
				const recompute = getEncodedNoAuth().pipe(
					Effect.map((encoded) =>
						Option.some({ encoded, key: JSON.stringify(encoded) }),
					),
					Effect.catchAll((error) =>
						Effect.logError(
							`Failed to compute replicant "${namespace}/${name}"`,
							error,
						).pipe(
							Effect.as(Option.none<{ encoded: JsonValue; key: string }>()),
						),
					),
				);
				const seed = yield* recompute;
				return Stream.concat(
					Stream.fromIterable(Option.isSome(seed) ? [seed.value] : []),
					changesStream.pipe(
						Stream.mapEffect(() => recompute),
						Stream.filterMap((option) => option),
					),
				).pipe(
					Stream.changesWith((a, b) => a.key === b.key),
					Stream.map((item) => item.encoded),
				);
			});

			const subscribe = Effect.fn("subscribe")(function* () {
				const stream = yield* subscribeEncoded();
				return stream.pipe(
					Stream.mapEffect((value) =>
						manifest.decode(value).pipe(migrationDie),
					),
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
		}),
);

export type ComputedFieldEffect<Decoded> = Effect.Effect.Success<
	ReturnType<typeof buildComputed<Decoded>>
>;
