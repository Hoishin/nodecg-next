import { defineState } from "@nodecg/core";
import { expect, expectTypeOf, test } from "vitest";
import z from "zod";

import { GetStateError, loadState, UpdateStateError } from "./load-state";

test("set seeds an initial value that getValue reads back", async () => {
	const manifest = defineState("test-set", { count: { schema: z.number() } });
	const state = loadState(manifest);

	expectTypeOf(state.count.getValue).toEqualTypeOf<() => Promise<number>>();

	await state.count.set(7);
	expect(await state.count.getValue()).toBe(7);
});

test("update transforms the current value", async () => {
	const manifest = defineState("test-update", { count: { schema: z.number() } });
	const state = loadState(manifest);

	await state.count.set(10);
	await state.count.update((v) => v + 3);
	expect(await state.count.getValue()).toBe(13);
});

test("safeGetValue returns a Result-wrapped GetStateError when uninitialised", async () => {
	const manifest = defineState("test-uninit", { count: { schema: z.number() } });
	const state = loadState(manifest);

	const result = await state.count.safeGetValue();
	expect(result.isErr()).toBe(true);
	if (result.isErr()) {
		expect(result.error).toBeInstanceOf(GetStateError);
		expect(result.error.message).toBe(
			'Failed to get state "count" in "test-uninit": state has not been initialised',
		);
	}
});

test("safeUpdate returns Err when uninitialised (cannot transform a missing value)", async () => {
	const manifest = defineState("test-update-uninit", { count: { schema: z.number() } });
	const state = loadState(manifest);

	const result = await state.count.safeUpdate((v) => v + 1);
	expect(result.isErr()).toBe(true);
	if (result.isErr()) {
		expect(result.error).toBeInstanceOf(UpdateStateError);
	}
});

test("safeSet returns Err when value fails schema validation", async () => {
	const manifest = defineState("test-validate", { count: { schema: z.number() } });
	const state = loadState(manifest);

	const result = await state.count.safeSet("not a number" as unknown as number);
	expect(result.isErr()).toBe(true);
	if (result.isErr()) {
		expect(result.error).toBeInstanceOf(UpdateStateError);
	}
});
