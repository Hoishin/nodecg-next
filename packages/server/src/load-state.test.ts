import { defineState } from "@nodecg/core";
import { expect, expectTypeOf, test } from "vitest";
import z from "zod";

import { loadState, UpdateStateError } from "./load-state";

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
