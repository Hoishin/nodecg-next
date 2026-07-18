import { Effect } from "effect";

import { type BuiltNamespace } from "./build-fields.ts";
import { fieldInternal } from "./field-builders/field-internal-key.ts";

type ReplicantFieldInternal =
	BuiltNamespace["replicant"][string][typeof fieldInternal];
type ComputedFieldInternal =
	BuiltNamespace["computed"][string][typeof fieldInternal];
type TopicFieldInternal = BuiltNamespace["topic"][string][typeof fieldInternal];
type RpcFieldInternal = BuiltNamespace["rpc"][string][typeof fieldInternal];

export interface FieldRegistry {
	readonly replicant: ReadonlyMap<
		string,
		ReadonlyMap<string, ReplicantFieldInternal>
	>;
	readonly computed: ReadonlyMap<
		string,
		ReadonlyMap<string, ComputedFieldInternal>
	>;
	readonly topic: ReadonlyMap<string, ReadonlyMap<string, TopicFieldInternal>>;
	readonly rpc: ReadonlyMap<string, ReadonlyMap<string, RpcFieldInternal>>;
}

export interface RegisteredNamespace {
	readonly namespace: string;
	readonly fields: BuiltNamespace;
}

export class FieldRegistryService extends Effect.Service<FieldRegistryService>()(
	"FieldRegistry",
	{
		effect: (namespaces: ReadonlyArray<RegisteredNamespace>) =>
			Effect.sync((): FieldRegistry => {
				const replicant = new Map<
					string,
					Map<string, ReplicantFieldInternal>
				>();
				const computed = new Map<string, Map<string, ComputedFieldInternal>>();
				const topic = new Map<string, Map<string, TopicFieldInternal>>();
				const rpc = new Map<string, Map<string, RpcFieldInternal>>();
				for (const { namespace, fields } of namespaces) {
					const replicantFields = new Map<string, ReplicantFieldInternal>();
					for (const [name, field] of Object.entries(fields.replicant)) {
						replicantFields.set(name, field[fieldInternal]);
					}
					replicant.set(namespace, replicantFields);
					const computedFields = new Map<string, ComputedFieldInternal>();
					for (const [name, field] of Object.entries(fields.computed)) {
						computedFields.set(name, field[fieldInternal]);
					}
					computed.set(namespace, computedFields);
					const topicFields = new Map<string, TopicFieldInternal>();
					for (const [name, field] of Object.entries(fields.topic)) {
						topicFields.set(name, field[fieldInternal]);
					}
					topic.set(namespace, topicFields);
					const rpcFields = new Map<string, RpcFieldInternal>();
					for (const [name, field] of Object.entries(fields.rpc)) {
						rpcFields.set(name, field[fieldInternal]);
					}
					rpc.set(namespace, rpcFields);
				}
				return { replicant, computed, topic, rpc };
			}),
	},
) {}
