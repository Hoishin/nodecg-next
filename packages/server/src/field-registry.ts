import {
	type LoadedNamespace,
	fieldInternal,
	namespaceMetadataKey,
} from "./load-namespace.ts";

type StateFieldInternal =
	LoadedNamespace["state"][string][typeof fieldInternal];
type ComputedFieldInternal =
	LoadedNamespace["computed"][string][typeof fieldInternal];
type TopicFieldInternal =
	LoadedNamespace["topic"][string][typeof fieldInternal];
type RpcFieldInternal = LoadedNamespace["rpc"][string][typeof fieldInternal];

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
		const { namespace } = loaded[namespaceMetadataKey];
		const stateFields = new Map<string, StateFieldInternal>();
		for (const [name, field] of Object.entries(loaded.state)) {
			stateFields.set(name, field[fieldInternal]);
		}
		state.set(namespace, stateFields);
		const computedFields = new Map<string, ComputedFieldInternal>();
		for (const [name, field] of Object.entries(loaded.computed)) {
			computedFields.set(name, field[fieldInternal]);
		}
		computed.set(namespace, computedFields);
		const topicFields = new Map<string, TopicFieldInternal>();
		for (const [name, field] of Object.entries(loaded.topic)) {
			topicFields.set(name, field[fieldInternal]);
		}
		topic.set(namespace, topicFields);
		const rpcFields = new Map<string, RpcFieldInternal>();
		for (const [name, field] of Object.entries(loaded.rpc)) {
			rpcFields.set(name, field[fieldInternal]);
		}
		rpc.set(namespace, rpcFields);
	}
	return { state, computed, topic, rpc };
};
