import { defineState } from "@nodecg/core";
import { expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";

import { loadState } from "./load-state";

test("runs in a real browser", () => {
	expect(typeof window).toBe("object");
	expect(typeof document).toBe("object");
});

test("getValue fetches and returns the response body", async () => {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify(42), { status: 200 }),
	);

	const stateDefinition = defineState({ count: { schema: z.number() } });

	const state = loadState(stateDefinition);

	expectTypeOf(state).toEqualTypeOf<{
		count: { getValue: () => Promise<number> };
	}>();

	const value = await state.count.getValue();

	expect(value).toBe(42);
	expect(globalThis.fetch).toHaveBeenCalledWith("/api/namespaces/root/state/count");
});
