import { mapValues } from "@nodecg/internal";
import { Effect } from "effect";
import { z } from "zod";

interface StateOptions<Encoded> {
	schema: z.ZodType<Encoded>;
}

interface StateDefinitionConfig {
	namespace?: string;
}

export interface StateDefinition<T> {
	name: string;
	parse: (value: unknown) => Effect.Effect<T, string>;
}

export interface StateDefinitions<Definitions extends Record<string, unknown>> {
	namespace: string;
	definitions: {
		[K in keyof Definitions]: StateDefinition<Definitions[K]>;
	};
}

export function defineState<Definitions extends Record<string, StateOptions<unknown>>>(
	definitions: Definitions,
	config?: StateDefinitionConfig,
): StateDefinitions<{
	[K in keyof Definitions]: z.infer<Definitions[K]["schema"]>;
}> {
	return {
		namespace: config?.namespace ?? "root",
		definitions: mapValues(definitions, (options, name) => ({
			name: String(name),
			parse: (value: unknown) => {
				const result = options.schema.safeParse(value);
				if (result.success) {
					return Effect.succeed(result.data as never);
				} else {
					return Effect.fail(result.error.message);
				}
			},
		})),
	};
}
