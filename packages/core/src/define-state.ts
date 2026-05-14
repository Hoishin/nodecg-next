import { mapValues } from "@nodecg/internal";
import { Data, Effect, type HKT } from "effect";
import type { JsonValue } from "type-fest";
import { z } from "zod";

type EnforceJsonValue<T> = [T] extends [JsonValue] ? T : never;

interface StateOptions<Decoded> {
	schema: z.ZodDefault<z.ZodType<EnforceJsonValue<Decoded>, EnforceJsonValue<Decoded>>>;
}

export class StateValidationError extends Data.TaggedError("StateValidationError")<{
	readonly name: string;
	readonly cause: string;
}> {
	override get message() {
		return `Failed to validate state "${this.name}": ${this.cause}`;
	}
}

export interface StateDefinition<Decoded> {
	name: string;
	getDefault: () => EnforceJsonValue<Decoded>;
	encode: (value: Decoded) => Effect.Effect<JsonValue, StateValidationError>;
}

export interface StateManifest<Values extends Record<string, unknown>> {
	namespace: string;
	definitions: {
		[K in keyof Values & string]: StateDefinition<Values[K]>;
	};
}

interface StateOptionsLambda extends HKT.TypeLambda {
	readonly type: StateOptions<this["Target"]>;
}

interface StateDefinitionLambda extends HKT.TypeLambda {
	readonly type: StateDefinition<this["Target"]>;
}

function implementDefinition<Decoded>(
	{ schema }: StateOptions<Decoded>,
	name: string,
): StateDefinition<Decoded> {
	z.toJSONSchema(schema);
	return {
		name,
		getDefault: () => schema.parse(undefined),
		encode: Effect.fn("encode")(function* (value: unknown) {
			const result = schema.safeParse(value);
			if (result.success) {
				return result.data;
			}
			return yield* new StateValidationError({ name, cause: result.error.message });
		}),
	};
}

export function defineState<Values extends Record<string, JsonValue>>(
	namespace: string,
	definitions: {
		[K in keyof Values & string]: StateOptions<Values[K]>;
	},
): StateManifest<Values> {
	return {
		namespace,
		definitions: mapValues<StateOptionsLambda, StateDefinitionLambda, Values>(
			definitions,
			(options, name) => implementDefinition(options, name),
		),
	};
}
