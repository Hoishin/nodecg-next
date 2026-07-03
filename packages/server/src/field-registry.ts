import {
	type LoadedNamespace,
	stateFieldInternal,
	stateMetadataKey,
} from "./load-namespace.ts";

type StateFieldInternal =
	LoadedNamespace["state"][string][typeof stateFieldInternal];
type ComputedFieldInternal =
	LoadedNamespace["computed"][string][typeof stateFieldInternal];
type TopicFieldInternal =
	LoadedNamespace["topic"][string][typeof stateFieldInternal];
type RpcFieldInternal =
	LoadedNamespace["rpc"][string][typeof stateFieldInternal];

export interface FieldRegistry {
	readonly state: ReadonlyMap<string, ReadonlyMap<string, StateFieldInternal>>;
	readonly computed: ReadonlyMap<
		string,
		ReadonlyMap<string, ComputedFieldInternal>
	>;
	readonly topic: ReadonlyMap<string, ReadonlyMap<string, TopicFieldInternal>>;
	readonly rpc: ReadonlyMap<string, ReadonlyMap<string, RpcFieldInternal>>;
}

export const buildFieldRegistry = (
	namespaces: ReadonlyArray<LoadedNamespace>,
): FieldRegistry => {
	const state = new Map<string, Map<string, StateFieldInternal>>();
	const computed = new Map<string, Map<string, ComputedFieldInternal>>();
	const topic = new Map<string, Map<string, TopicFieldInternal>>();
	const rpc = new Map<string, Map<string, RpcFieldInternal>>();
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
		const topicFields = new Map<string, TopicFieldInternal>();
		for (const [name, field] of Object.entries(loaded.topic)) {
			topicFields.set(name, field[stateFieldInternal]);
		}
		topic.set(namespace, topicFields);
		const rpcFields = new Map<string, RpcFieldInternal>();
		for (const [name, field] of Object.entries(loaded.rpc)) {
			rpcFields.set(name, field[stateFieldInternal]);
		}
		rpc.set(namespace, rpcFields);
	}
	return { state, computed, topic, rpc };
};
