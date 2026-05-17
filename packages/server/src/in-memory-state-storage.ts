import { toError } from "@nodecg/internal";
import { Context, Effect, Layer } from "effect";
import type { JsonValue } from "type-fest";

import {
	StateAlreadyExists,
	StateNotFound,
	StateSaveFailed,
	StateStorageService,
} from "./state-storage";

export function createInMemoryStateStorage(): Context.Tag.Service<
	typeof StateStorageService
> {
	const map = new Map<string, Map<string, JsonValue>>();

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
	});

	return { read, create, update, persistInterval: 0 };
}

export const InMemoryStateStorage = Layer.sync(StateStorageService, () =>
	createInMemoryStateStorage(),
);
