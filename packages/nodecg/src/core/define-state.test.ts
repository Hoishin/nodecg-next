import { Effect } from "effect";
import { expect, expectTypeOf, test } from "vitest";
import z from "zod";

import { defineState } from "./define-state";
import { testEffect } from "../../test/effect";

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
				namespace: string | undefined;
				states: {
					count: {
						name: "count";
						parse: (value: unknown) => Effect.Effect<number, string>;
					};
				};
			}>();

			const success = yield* stateDefinition.states.count.parse(123);
			expect(success).toBe(123);

			const failure = yield* stateDefinition.states.count.parse("abc").pipe(Effect.flip);
			expect(failure).toBeTruthy();
		}),
	),
);
