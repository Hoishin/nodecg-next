import {
	defineState,
	StateValidationError,
	type StateDefinition,
	type StateManifest,
} from "@nodecg/core";
import { Effect, Schema } from "effect";
import { expect, expectTypeOf, test } from "vitest";

import { GetStateError, loadState, UpdateStateError } from "./load-state";
import { store } from "./store";

test("schema seeds the initial value", async () => {
	const manifest = defineState("test-default", {
		count: { schema: Schema.Number, initialValue: () => 42 },
	});
	const state = loadState(manifest);

	expectTypeOf(state.count.getValue).toEqualTypeOf<() => Promise<number>>();

	expect(await state.count.getValue()).toBe(42);
});

test("set overrides the seeded initial value", async () => {
	const manifest = defineState("test-set", {
		count: { schema: Schema.Number, initialValue: () => 0 },
	});
	const state = loadState(manifest);

	await state.count.set(7);
	expect(await state.count.getValue()).toBe(7);
});

test("update transforms the current value", async () => {
	const manifest = defineState("test-update", {
		count: { schema: Schema.Number, initialValue: () => 10 },
	});
	const state = loadState(manifest);

	await state.count.update((v) => v + 3);
	expect(await state.count.getValue()).toBe(13);
});

test("safeSet returns Err when value fails schema validation", async () => {
	const manifest = defineState("test-validate", {
		count: { schema: Schema.Number, initialValue: () => 0 },
	});
	const state = loadState(manifest);

	const result = await state.count.safeSet("not a number" as unknown as number);
	expect(result.isErr()).toBe(true);
	if (result.isErr()) {
		expect(result.error).toBeInstanceOf(UpdateStateError);
	}
});

test("getValue fails with validation error when store has bad data", async () => {
	const manifest = defineState("test-decode-fail", {
		count: { schema: Schema.Number, initialValue: () => 0 },
	});
	const state = loadState(manifest);

	store.set("test-decode-fail", "count", "not a number");

	await expect(state.count.getValue()).rejects.toThrow(
		/Failed to get state "count" in "test-decode-fail"/,
	);
});

test("safeGetValue returns Err when store has bad data", async () => {
	const manifest = defineState("test-safe-decode-fail", {
		count: { schema: Schema.Number, initialValue: () => 0 },
	});
	const state = loadState(manifest);

	store.set("test-safe-decode-fail", "count", "not a number");

	const result = await state.count.safeGetValue();
	expect(result.isErr()).toBe(true);
	if (result.isErr()) {
		expect(result.error).toBeInstanceOf(GetStateError);
	}
});

test("loadState throws if encode rejects the initial value", () => {
	const definition: StateDefinition<number> = {
		name: "broken",
		getInitial: () => 42,
		encode: () =>
			Effect.fail(
				new StateValidationError({ name: "broken", cause: "rejected on seed" }),
			),
		decode: () => Effect.succeed(0),
	};
	const manifest: StateManifest<{ broken: typeof Schema.Number }> = {
		namespace: "test-encode-seed-fail",
		definitions: { broken: definition },
	};

	expect(() => loadState(manifest)).toThrow(/rejected on seed/);
});

test("bidirectional codec round-trips via wire storage", async () => {
	const manifest = defineState("test-codec", {
		when: {
			schema: Schema.DateFromString,
			initialValue: () => new Date(0),
		},
	});
	const state = loadState(manifest);

	expect(await state.when.getValue()).toEqual(new Date(0));

	const newDate = new Date("2026-05-14T00:00:00.000Z");
	await state.when.set(newDate);

	expect(store.get("test-codec", "when")).toBe("2026-05-14T00:00:00.000Z");
	expect(await state.when.getValue()).toEqual(newDate);
});
