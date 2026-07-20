import { Effect, Layer, PubSub, Stream } from "effect";
import type { JsonValue } from "type-fest";

import {
	type ReplicantChange,
	ReplicantNotFound,
	ReplicantStorageService,
} from "./replicant-storage.ts";

export const InMemoryReplicantStorage = Layer.effect(
	ReplicantStorageService,
	Effect.gen(function* () {
		const map = new Map<string, Map<string, JsonValue>>();
		const changes = yield* PubSub.unbounded<ReplicantChange>();

		const read = (
			namespace: string,
			name: string,
		): Effect.Effect<JsonValue, ReplicantNotFound> => {
			const value = map.get(namespace)?.get(name);
			// JavaScript `undefined` is not a valid JSON value, thus means value not defined
			if (typeof value === "undefined") {
				return new ReplicantNotFound({ namespace, name });
			}
			return Effect.succeed(value);
		};

		const write = Effect.fn("ReplicantStorage.write")(function* (
			namespace: string,
			name: string,
			value: JsonValue,
			createIfNotFound = false,
		) {
			const ns = map.get(namespace);
			const exists = typeof ns?.get(name) !== "undefined";
			if (!exists && !createIfNotFound) {
				return yield* new ReplicantNotFound({ namespace, name });
			}
			if (ns) {
				ns.set(name, value);
			} else {
				map.set(namespace, new Map([[name, value]]));
			}
			yield* changes.publish({ namespace, name, value });
		});

		return {
			read,
			write,
			subscribe: () => Stream.fromPubSub(changes, { scoped: true }),
			flush: () => Effect.void,
		};
	}),
);
