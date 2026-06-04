import { Effect, Layer, Option, PubSub, Stream } from "effect";
import type { JsonValue } from "type-fest";

import {
	type StateChange,
	StateAlreadyExists,
	StateNotFound,
	StateStorageService,
} from "./state-storage.ts";

export const InMemoryStateStorage = Layer.effect(
	StateStorageService,
	Effect.gen(function* () {
		const map = new Map<string, Map<string, JsonValue>>();
		const changes = yield* PubSub.unbounded<StateChange>();

		const read = (
			namespace: string,
			name: string,
		): Option.Option<JsonValue> => {
			const value = map.get(namespace)?.get(name);
			// JavaScript `undefined` is not a valid JSON value, thus means value not defined
			if (typeof value === "undefined") {
				return Option.none();
			}
			return Option.some(value);
		};

		const create = Effect.fn("StateStorage.create")(function* (
			namespace: string,
			name: string,
			value: JsonValue,
		) {
			const ns = map.get(namespace);
			if (typeof ns?.get(name) !== "undefined") {
				return yield* new StateAlreadyExists({ namespace, name });
			}
			if (ns) {
				ns.set(name, value);
			} else {
				map.set(namespace, new Map([[name, value]]));
			}
			yield* changes.publish({ namespace, name, value });
		});

		const update = Effect.fn("StateStorage.update")(function* (
			namespace: string,
			name: string,
			value: JsonValue,
		) {
			const ns = map.get(namespace);
			if (!ns) {
				return yield* new StateNotFound({ namespace, name });
			}
			ns.set(name, value);
			yield* changes.publish({ namespace, name, value });
		});

		return {
			read,
			create,
			update,
			subscribe: () => Stream.fromPubSub(changes, { scoped: true }),
			flush: () => Effect.void,
		};
	}),
);
