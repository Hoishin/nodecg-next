import type { RoleName } from "@nodecg/internal";
import { Effect } from "effect";

import { type BuiltNamespace } from "./build-fields.ts";
import { fieldInternal } from "./field-builders/field-internal-key.ts";

// Exclude Decoded types
type ReplicantFieldInternal = Pick<
	BuiltNamespace["replicant"][string][typeof fieldInternal],
	"getEncoded" | "setEncoded" | "subscribeEncoded" | "permission"
>;
type ComputedFieldInternal = Pick<
	BuiltNamespace["computed"][string][typeof fieldInternal],
	"getEncoded" | "getEncodedNoAuth" | "subscribeEncoded" | "permission"
>;
type TopicFieldInternal = Pick<
	BuiltNamespace["topic"][string][typeof fieldInternal],
	"publishEncoded" | "subscribeEncoded" | "permission"
>;
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
	readonly declaredRoles: ReadonlyMap<string, ReadonlySet<RoleName>>;
}

export interface RegisteredNamespace {
	readonly namespace: string;
	readonly declaredRoles: ReadonlySet<RoleName>;
	readonly fields: {
		readonly replicant: Record<
			string,
			{ readonly [fieldInternal]: ReplicantFieldInternal }
		>;
		readonly computed: Record<
			string,
			{ readonly [fieldInternal]: ComputedFieldInternal }
		>;
		readonly topic: Record<
			string,
			{ readonly [fieldInternal]: TopicFieldInternal }
		>;
		readonly rpc: Record<
			string,
			{ readonly [fieldInternal]: RpcFieldInternal }
		>;
	};
}

// transport lookup on single field by name, encoded types only
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
				const declaredRoles = new Map<string, ReadonlySet<RoleName>>();
				for (const registered of namespaces) {
					const { namespace, fields } = registered;
					declaredRoles.set(namespace, registered.declaredRoles);
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
				return { replicant, computed, topic, rpc, declaredRoles };
			}),
	},
) {}
