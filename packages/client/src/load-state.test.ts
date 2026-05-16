import { defineState } from "@nodecg/core";
import { testEffect } from "@nodecg/private";
import { Effect, Schema } from "effect";
import type { JsonValue } from "type-fest";
import { expect, test } from "vitest";

import { loadState, loadStateEffect } from "./load-state";
import {
	StateNotFound,
	type StateTransport,
	StateTransportService,
} from "./state-transport";

function createInMemoryTransport(): StateTransport {
	const map = new Map<string, Map<string, JsonValue>>();
	return {
		get: Effect.fn("get")(function* (namespace: string, name: string) {
			const value = map.get(namespace)?.get(name);
			if (typeof value === "undefined") {
				return yield* new StateNotFound({ namespace, name });
			}
			return value;
		}),
		update: Effect.fn("update")(function* (
			namespace: string,
			name: string,
			value: JsonValue,
		) {
			yield* Effect.sync(() => {
				const ns = map.get(namespace);
				if (ns) {
					ns.set(name, value);
				} else {
					map.set(namespace, new Map([[name, value]]));
				}
			});
		}),
	};
}

test("loadState — Promise wrapper end-to-end", async () => {
	const manifest = defineState("test-loadstate-basic", {
		count: { schema: Schema.Number },
	});
	const state = await loadState({
		manifest,
		transport: createInMemoryTransport(),
	});

	await state.count.set(42);
	expect(await state.count.getValue()).toBe(42);
});

test(
	"getValue decodes the value held by the transport",
	testEffect(
		Effect.gen(function* () {
			const transport = createInMemoryTransport();
			const provide = Effect.provideService(StateTransportService, transport);
			const manifest = defineState("root", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect(manifest).pipe(provide);

			yield* transport.update("root", "count", 42);

			expect(yield* state.count.getValue().pipe(provide)).toBe(42);
		}),
	),
);

test(
	"update reads the current value, applies the fn, and writes the result",
	testEffect(
		Effect.gen(function* () {
			const transport = createInMemoryTransport();
			const provide = Effect.provideService(StateTransportService, transport);
			const manifest = defineState("root", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect(manifest).pipe(provide);

			yield* transport.update("root", "count", 10);
			yield* state.count.update((v) => v + 5).pipe(provide);

			expect(yield* state.count.getValue().pipe(provide)).toBe(15);
		}),
	),
);

test(
	"bidirectional codec round-trips through the transport wire",
	testEffect(
		Effect.gen(function* () {
			const transport = createInMemoryTransport();
			const provide = Effect.provideService(StateTransportService, transport);
			const manifest = defineState("root", {
				when: { schema: Schema.DateFromString },
			});
			const state = yield* loadStateEffect(manifest).pipe(provide);

			const newDate = new Date("2030-01-01T00:00:00.000Z");
			yield* state.when.set(newDate).pipe(provide);

			const wire = yield* transport.get("root", "when");
			expect(wire).toBe("2030-01-01T00:00:00.000Z");
			expect(yield* state.when.getValue().pipe(provide)).toEqual(newDate);
		}),
	),
);

test(
	"getValue fails when the transport has no value for the state",
	testEffect(
		Effect.gen(function* () {
			const transport = createInMemoryTransport();
			const provide = Effect.provideService(StateTransportService, transport);
			const manifest = defineState("root", {
				count: { schema: Schema.Number },
			});
			const state = yield* loadStateEffect(manifest).pipe(provide);

			const result = yield* Effect.either(state.count.getValue().pipe(provide));
			expect(result._tag).toBe("Left");
		}),
	),
);
