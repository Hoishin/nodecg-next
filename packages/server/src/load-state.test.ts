import {
	defineState,
	StateValidationError,
	type StateDefinition,
	type StateManifest,
} from "@nodecg/core";
import { Effect } from "effect";
import { expect, expectTypeOf, test } from "vitest";
import z from "zod";

import { GetStateError, loadState, UpdateStateError } from "./load-state";
import { store } from "./store";

test("schema .default() seeds the initial value", async () => {
	const manifest = defineState("test-default", {
		count: { schema: z.number().default(42) },
	});
	const state = loadState(manifest);

	expectTypeOf(state.count.getValue).toEqualTypeOf<() => Promise<number>>();

	expect(await state.count.getValue()).toBe(42);
});

test("set overrides the seeded default", async () => {
	const manifest = defineState("test-set", {
		count: { schema: z.number().default(0) },
	});
	const state = loadState(manifest);

	await state.count.set(7);
	expect(await state.count.getValue()).toBe(7);
});

test("update transforms the current value", async () => {
	const manifest = defineState("test-update", {
		count: { schema: z.number().default(10) },
	});
	const state = loadState(manifest);

	await state.count.update((v) => v + 3);
	expect(await state.count.getValue()).toBe(13);
});

test("safeSet returns Err when value fails schema validation", async () => {
	const manifest = defineState("test-validate", {
		count: { schema: z.number().default(0) },
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
		count: { schema: z.number().default(0) },
	});
	const state = loadState(manifest);

	store.set("test-decode-fail", "count", "not a number");

	await expect(state.count.getValue()).rejects.toThrow(
		/Failed to get state "count" in "test-decode-fail"/,
	);
});

test("safeGetValue returns Err when store has bad data", async () => {
	const manifest = defineState("test-safe-decode-fail", {
		count: { schema: z.number().default(0) },
	});
	const state = loadState(manifest);

	store.set("test-safe-decode-fail", "count", "not a number");

	const result = await state.count.safeGetValue();
	expect(result.isErr()).toBe(true);
	if (result.isErr()) {
		expect(result.error).toBeInstanceOf(GetStateError);
	}
});

test("loadState throws if encode rejects the default", () => {
	const definition: StateDefinition<number> = {
		name: "broken",
		getDefault: () => 42,
		encode: () =>
			Effect.fail(
				new StateValidationError({ name: "broken", cause: "rejected on seed" }),
			),
		decode: () => Effect.succeed(0),
	};
	const manifest: StateManifest<{ broken: number }> = {
		namespace: "test-encode-seed-fail",
		definitions: { broken: definition },
	};

	expect(() => loadState(manifest)).toThrow(/rejected on seed/);
});
