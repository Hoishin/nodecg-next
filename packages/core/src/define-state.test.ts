import { Effect } from "effect";
import { expect, expectTypeOf, test } from "vitest";
import z from "zod";

import { testEffect } from "@nodecg/private";

import { defineState } from "./define-state";

test(
	"base",
	testEffect(
		Effect.gen(function* () {
			const stateDefinition = defineState({
				count: {
					schema: z.number(),
				},
			});

			expectTypeOf(stateDefinition).toEqualTypeOf<{
				namespace: string;
				definitions: {
					count: {
						name: string;
						parse: (value: unknown) => Effect.Effect<number, string>;
					};
				};
			}>();

			const success = yield* stateDefinition.definitions.count.parse(123);
			expect(success).toBe(123);

			const failure = yield* stateDefinition.definitions.count.parse("abc").pipe(Effect.flip);
			expect(failure).toBeTruthy();
		}),
	),
);
