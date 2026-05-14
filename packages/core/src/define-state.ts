import { mapValues } from "@nodecg/internal";
import { Data, Effect, type HKT } from "effect";
import type { JsonValue } from "type-fest";
import { z } from "zod";

interface StateOptions<T> {
	schema: z.ZodType<T, T>;
}

export class StateValidationError extends Data.TaggedError("StateValidationError")<{
	readonly name: string;
	readonly cause: string;
}> {
	override get message() {
		return `Validation failed for state "${this.name}": ${this.cause}`;
	}
}

export interface StateDefinition<T> {
	name: string;
	validate: (value: unknown) => Effect.Effect<T, StateValidationError>;
}

export interface StateManifest<Definitions extends Record<string, unknown>> {
	namespace: string;
	definitions: {
		[K in keyof Definitions & string]: StateDefinition<Definitions[K]>;
	};
}

interface StateOptionsLambda extends HKT.TypeLambda {
	readonly type: StateOptions<this["Target"]>;
}

interface StateDefinitionLambda extends HKT.TypeLambda {
	readonly type: StateDefinition<this["Target"]>;
}

export function defineState<Values extends Record<string, JsonValue>>(
	namespace: string,
	definitions: { [K in keyof Values & string]: StateOptions<Values[K]> },
): StateManifest<Values> {
	return {
		namespace,
		definitions: mapValues<StateOptionsLambda, StateDefinitionLambda, Values>(
			definitions,
			(options, name) => ({
				name,
				validate: Effect.fn("validate")(function* (value: unknown) {
					const result = options.schema.safeParse(value);
					if (result.success) {
						return result.data;
					}
					return yield* new StateValidationError({ name, cause: result.error.message });
				}),
			}),
		),
	};
}
