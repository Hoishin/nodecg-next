import { Effect } from "effect";
import type { JsonValue } from "type-fest";

import {
	StateNotFound,
	StateSaveFailed,
	type StatePersistenceAdapter,
} from "./persistence-adapter";

const inMemoryMap = new Map<string, Map<string, JsonValue>>();

export const inMemoryPersistenceAdapter = {
	get: Effect.fn("inMemoryPersistenceAdapter.get")(function* (namespace, name) {
		const lookup = inMemoryMap.get(namespace)?.get(name);
		if (typeof lookup === "undefined") {
			return yield* new StateNotFound({ namespace, name });
		}
		return lookup;
	}),
	set: Effect.fn("inMemoryPersistenceAdapter.set")(
		function* (namespace, name, value) {
			return yield* Effect.try({
				try: () => {
					const namespaceValue = inMemoryMap.get(namespace);
					if (namespaceValue) {
						namespaceValue.set(name, value);
					} else {
						inMemoryMap.set(namespace, new Map([[name, value]]));
					}
				},
				catch: (error) => {
					return new StateSaveFailed({
						namespace,
						name,
						cause:
							error instanceof Error
								? error
								: new Error("Unknown error", { cause: error }),
					});
				},
			});
		},
	),
	update: Effect.fn("inMemoryPersistenceAdapter.update")(
		function* (namespace, name, value) {
			const updated = yield* Effect.try({
				try: () => {
					const namespaceValue = inMemoryMap.get(namespace);
					if (namespaceValue) {
						namespaceValue.set(name, value);
						return true;
					} else {
						return false;
					}
				},
				catch: (error) => {
					return new StateSaveFailed({
						namespace,
						name,
						cause:
							error instanceof Error
								? error
								: new Error("Unknown error", { cause: error }),
					});
				},
			});
			if (!updated) {
				return yield* new StateNotFound({ namespace, name });
			}
		},
	),
	persistInterval: 0,
} satisfies StatePersistenceAdapter;
