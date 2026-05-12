import type { StateDefinition, StateDefinitions } from "@nodecg/core";
import { mapValues } from "@nodecg/internal";

interface State<T> {
	getValue: () => Promise<T>;
}

function implementState<T>(
	namespace: string,
	name: string,
	_definition: StateDefinition<T>,
): State<T> {
	const getValue = async () => {
		const response = await fetch(`/api/namespaces/${namespace}/state/${name}`);
		if (!response.ok) {
			throw new Error(`Failed to load state "${name}": ${response.statusText}`);
		}
		const body = await response.json();
		return body as T;
	};
	return {
		getValue,
	};
}

export function loadState<Definitions extends Record<string, unknown>>(
	stateDefinition: StateDefinitions<Definitions>,
): {
	[K in keyof Definitions]: State<Definitions[K]>;
} {
	return mapValues(stateDefinition.definitions, (definition, name) =>
		implementState(stateDefinition.namespace, String(name), definition),
	);
}
