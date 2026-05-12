import { Effect } from "effect";
import { z } from "zod";

interface StateOptions<Encoded> {
	schema: z.ZodType<Encoded>;
}

interface StateDefinitionConfig {
	namespace?: string;
}

interface StateDefinition<Definitions extends Record<string, unknown>> {
	namespace: string | undefined;
	states: {
		[K in keyof Definitions]: {
			name: K;
			parse: (value: unknown) => Effect.Effect<Definitions[K], string>;
		};
	};
}

export function defineState<Definitions extends Record<string, StateOptions<unknown>>>(
	definitions: Definitions,
	config?: StateDefinitionConfig,
): StateDefinition<{
	[K in keyof Definitions]: z.infer<Definitions[K]["schema"]>;
}> {
	const states: any = {};

	for (const [name, options] of Object.entries(definitions)) {
		states[name] = {
			name,
			parse: (value: unknown) => {
				const result = options.schema.safeParse(value);
				if (result.success) {
					return Effect.succeed(result.data);
				} else {
					return Effect.fail(result.error.message);
				}
			},
		};
	}

	return {
		namespace: config?.namespace,
		states,
	};
}
