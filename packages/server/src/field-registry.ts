import {
	type LoadedNamespace,
	stateFieldInternal,
	stateMetadataKey,
} from "./load-namespace.ts";

type StateFieldInternal =
	LoadedNamespace["state"][string][typeof stateFieldInternal];
type ComputedFieldInternal =
	LoadedNamespace["computed"][string][typeof stateFieldInternal];

export interface FieldRegistry {
	readonly state: ReadonlyMap<string, ReadonlyMap<string, StateFieldInternal>>;
	readonly computed: ReadonlyMap<
		string,
		ReadonlyMap<string, ComputedFieldInternal>
	>;
}

export const buildFieldRegistry = (
	namespaces: ReadonlyArray<LoadedNamespace>,
): FieldRegistry => {
	const state = new Map<string, Map<string, StateFieldInternal>>();
	const computed = new Map<string, Map<string, ComputedFieldInternal>>();
	for (const loaded of namespaces) {
		const { namespace } = loaded[stateMetadataKey];
		const stateFields = new Map<string, StateFieldInternal>();
		for (const [name, field] of Object.entries(loaded.state)) {
			stateFields.set(name, field[stateFieldInternal]);
		}
		state.set(namespace, stateFields);
		const computedFields = new Map<string, ComputedFieldInternal>();
		for (const [name, field] of Object.entries(loaded.computed)) {
			computedFields.set(name, field[stateFieldInternal]);
		}
		computed.set(namespace, computedFields);
	}
	return { state, computed };
};
