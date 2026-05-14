import { testEffect } from "@nodecg/private";
import { Effect } from "effect";
import type { JsonValue } from "type-fest";
import { describe, expect, expectTypeOf, test } from "vitest";
import z from "zod";

import { defineState, StateValidationError } from "./define-state";

test(
	"base",
	testEffect(
		Effect.gen(function* () {
			const manifest = defineState("test", {
				count: {
					schema: z.number(),
				},
			});

			expectTypeOf(manifest).toEqualTypeOf<{
				namespace: string;
				definitions: {
					count: {
						name: string;
						encode: (value: number) => Effect.Effect<JsonValue, StateValidationError>;
					};
				};
			}>();

			const encoded = yield* manifest.definitions.count.encode(123);
			expect(encoded).toBe(123);
		}),
	),
);

test("allows JSON compatible schema", () => {
	const manifest = defineState("test", {
		player: { schema: z.string() },
		score: { schema: z.number() },
		active: { schema: z.boolean() },
		config: { schema: z.object({ name: z.string(), score: z.number() }) },
		tags: { schema: z.array(z.string()) },
	});

	expectTypeOf(manifest.definitions.player).toEqualTypeOf<{
		name: string;
		encode: (value: string) => Effect.Effect<JsonValue, StateValidationError>;
	}>();
});

describe("does not allow JSON incompatible schema", () => {
	test("Date", () => {
		expect(() => {
			defineState("test", {
				// @ts-expect-error Date is not JsonValue-compatible
				when: { schema: z.date() },
			});
		}).toThrow();
	});

	test("BigInt", () => {
		expect(() => {
			defineState("test", {
				// @ts-expect-error BigInt is not JsonValue-compatible
				big: { schema: z.bigint() },
			});
		}).toThrow();
	});

	test("Map", () => {
		expect(() => {
			defineState("test", {
				// @ts-expect-error Map is not JsonValue-compatible
				lookup: { schema: z.map(z.string(), z.number()) },
			});
		}).toThrow();
	});

	test("Set", () => {
		expect(() => {
			defineState("test", {
				// @ts-expect-error Set is not JsonValue-compatible
				unique: { schema: z.set(z.string()) },
			});
		}).toThrow();
	});

	test("Symbol", () => {
		expect(() => {
			defineState("test", {
				// @ts-expect-error Symbol is not JsonValue-compatible
				token: { schema: z.symbol() },
			});
		}).toThrow();
	});
});

describe("does not allow zod schema with .transform()", () => {
	test("non-JSON-compatible output", () => {
		expect(() => {
			defineState("test", {
				// @ts-expect-error .transform() produces a non-JsonValue output that fails the schema constraint
				due: { schema: z.string().transform((s) => new Date(s)) },
			});
		}).toThrow();
	});

	test("JSON-compatible output", () => {
		expect(() => {
			defineState("test", {
				shout: { schema: z.string().transform((s) => s.toUpperCase()) },
			});
		}).toThrow();
	});
});
