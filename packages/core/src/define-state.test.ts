import { testEffect } from "@nodecg/private";
import { Effect } from "effect";
import { expect, expectTypeOf, test } from "vitest";
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
						validate: (value: unknown) => Effect.Effect<number, StateValidationError>;
					};
				};
			}>();

			const success = yield* manifest.definitions.count.validate(123);
			expect(success).toBe(123);

			const failure = yield* manifest.definitions.count.validate("abc").pipe(Effect.flip);
			expect(failure).toBeTruthy();
		}),
	),
);
