import { Effect } from "effect";
import type { JsonValue } from "type-fest";

import {
	StateNotFound,
	StateSaveFailed,
	type StateStorageAdapter,
} from "./state-storage";

export function createInMemoryStateStorage(): StateStorageAdapter {
	const map = new Map<string, Map<string, JsonValue>>();

	return {
		get: Effect.fn("inMemoryStateStorage.get")(function* (namespace, name) {
			const lookup = map.get(namespace)?.get(name);
			if (typeof lookup === "undefined") {
				return yield* new StateNotFound({ namespace, name });
			}
			return lookup;
		}),
		set: Effect.fn("inMemoryStateStorage.set")(
			function* (namespace, name, value) {
				return yield* Effect.try({
					try: () => {
						const namespaceValue = map.get(namespace);
						if (namespaceValue) {
							namespaceValue.set(name, value);
						} else {
							map.set(namespace, new Map([[name, value]]));
						}
					},
					catch: (error) =>
						new StateSaveFailed({
							namespace,
							name,
							cause:
								error instanceof Error
									? error
									: new Error("Unknown error", { cause: error }),
						}),
				});
			},
		),
		update: Effect.fn("inMemoryStateStorage.update")(
			function* (namespace, name, value) {
				const updated = yield* Effect.try({
					try: () => {
						const namespaceValue = map.get(namespace);
						if (namespaceValue) {
							namespaceValue.set(name, value);
							return true;
						}
						return false;
					},
					catch: (error) =>
						new StateSaveFailed({
							namespace,
							name,
							cause:
								error instanceof Error
									? error
									: new Error("Unknown error", { cause: error }),
						}),
				});
				if (!updated) {
					return yield* new StateNotFound({ namespace, name });
				}
			},
		),
		persistInterval: 0,
	};
}

export const inMemoryStateStorage = createInMemoryStateStorage();
