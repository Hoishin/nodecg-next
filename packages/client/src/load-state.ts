import type { StateDefinition, StateDefinitions } from "@nodecg/core";
import { mapValues } from "@nodecg/internal";
import { err, ok, type Result } from "neverthrow";
import type { JsonValue } from "type-fest";

interface State<T extends JsonValue> {
	getValue: () => Promise<Result<T, string>>;
	update: (fn: (value: T) => T | Promise<T>) => Promise<Result<void, string>>;
}

function implementState<T extends JsonValue>(
	namespace: string,
	name: string,
	definition: StateDefinition<T>,
): State<T> {
	const getValue = async () => {
		const response = await fetch(`/api/namespaces/${namespace}/state/${name}`);
		if (!response.ok) {
			return err(`Failed to get state value for ${name} in ${namespace}: ${response.statusText}`);
		}
		const body = await response.json();
		return ok(body as T);
	};

	const update = async (fn: (value: T) => T | Promise<T>) => {
		const current = await getValue();
		if (current.isErr()) {
			return current;
		}
		const next = fn(current.value);
		const parsedNext = definition.parse(next);
		const response = await fetch(`/api/namespaces/${namespace}/state/${name}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(parsedNext),
		});
		if (!response.ok) {
			return err(`Failed to update state "${name}": ${response.statusText}`);
		}
		return ok();
	};

	return {
		getValue,
		update,
	};
}

export function loadState<Definitions extends Record<string, JsonValue>>(
	stateDefinition: StateDefinitions<Definitions>,
): {
	[K in keyof Definitions]: State<Definitions[K]>;
} {
	return mapValues(stateDefinition.definitions, (definition, name) =>
		implementState(stateDefinition.namespace, String(name), definition),
	);
}
