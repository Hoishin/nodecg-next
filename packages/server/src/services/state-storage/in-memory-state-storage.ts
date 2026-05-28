import { toError } from "@nodecg/internal";
import { Effect, Layer, PubSub, Stream } from "effect";
import type { JsonValue } from "type-fest";

import {
	type StateChange,
	StateAlreadyExists,
	StateNotFound,
	StateSaveFailed,
	StateStorageService,
} from "./state-storage.ts";

export const createInMemoryStateStorage = Effect.fn(
	"createInMemoryStateStorage",
)(function* () {
	const map = new Map<string, Map<string, JsonValue>>();
	const pubsub = yield* PubSub.unbounded<StateChange>();

	const read = Effect.fn("StateStorage.read")(function* (
		namespace: string,
		name: string,
	) {
		const value = map.get(namespace)?.get(name);
		if (typeof value === "undefined") {
			return yield* new StateNotFound({ namespace, name });
		}
		return value;
	});

	const create = Effect.fn("StateStorage.create")(function* (
		namespace: string,
		name: string,
		value: JsonValue,
	) {
		if (typeof map.get(namespace)?.get(name) !== "undefined") {
			return yield* new StateAlreadyExists({ namespace, name });
		}
		return yield* Effect.try({
			try: () => {
				const ns = map.get(namespace);
				if (ns) {
					ns.set(name, value);
				} else {
					map.set(namespace, new Map([[name, value]]));
				}
			},
			catch: (error) =>
				new StateSaveFailed({ namespace, name, cause: toError(error) }),
		});
	});

	const update = Effect.fn("StateStorage.update")(function* (
		namespace: string,
		name: string,
		value: JsonValue,
	) {
		const updated = yield* Effect.try({
			try: () => {
				const ns = map.get(namespace);
				if (ns) {
					ns.set(name, value);
					return true;
				}
				return false;
			},
			catch: (error) =>
				new StateSaveFailed({ namespace, name, cause: toError(error) }),
		});
		if (!updated) {
			return yield* new StateNotFound({ namespace, name });
		}
		yield* pubsub.publish({ namespace, name, value });
	});

	return {
		read,
		create,
		update,
		changes: Stream.fromPubSub(pubsub),
		persistInterval: 0,
	};
});

export const InMemoryStateStorage = Layer.effect(
	StateStorageService,
	createInMemoryStateStorage(),
);
