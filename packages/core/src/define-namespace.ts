import {
	type AddedSchemas,
	mapSchemaValues,
	mapValues,
	mergeRecords,
} from "@nodecg/internal";
import { Data, Effect, type HKT, Schema } from "effect";
import type { JsonValue } from "type-fest";

export class StateEncodeError extends Data.TaggedError("StateEncodeError")<{
	readonly fieldName: string;
	readonly value: unknown;
	readonly cause: Error;
}> {
	override readonly message = `Failed to encode state "${this.fieldName}": ${this.cause.message}`;
}

export class StateDecodeError extends Data.TaggedError("StateDecodeError")<{
	readonly fieldName: string;
	readonly value: JsonValue;
	readonly cause: Error;
}> {
	override readonly message = `Failed to decode state "${this.fieldName}": ${this.cause.message}`;
}

export interface FieldCodec<Decoded> {
	readonly name: string;
	readonly encode: (
		value: Decoded,
	) => Effect.Effect<JsonValue, StateEncodeError>;
	readonly decode: (
		value: JsonValue,
	) => Effect.Effect<Decoded, StateDecodeError>;
}

function implementCodec<S extends Schema.Schema<any, JsonValue, never>>(
	name: string,
	schema: S,
): FieldCodec<Schema.Schema.Type<S>> {
	return {
		name,
		encode: Effect.fn("encode")(function* (value: Schema.Schema.Type<S>) {
			return yield* Schema.encode(schema)(value).pipe(
				Effect.catchTag(
					"ParseError",
					(error) =>
						new StateEncodeError({ fieldName: name, value, cause: error }),
				),
			);
		}),
		decode: Effect.fn("decode")(function* (value: JsonValue) {
			return yield* Schema.decode(schema)(value).pipe(
				Effect.catchTag(
					"ParseError",
					(error) =>
						new StateDecodeError({ fieldName: name, value, cause: error }),
				),
			);
		}),
	};
}

// ---- roles ----

export type Capability =
	| "state-read"
	| "state-write"
	| "computed-read"
	| "topic-subscribe"
	| "topic-publish";

// `superadmin` is the enforcement short-circuit (never listed). The rest are usable
// in field allow/deny: `server` (server-owned), `client` (all clients), `public`
// (anonymous). None can be declared as a named role.
const RESERVED_ROLES = ["superadmin", "server", "client", "public"] as const;
const RESERVED_ROLE_SET = new Set<string>(RESERVED_ROLES);

// `permission` is the role's default base; `deny` is a hard veto applied after field
// `allow`, so a denied capability can never be granted back by a field rule. Stored on the
// manifest so extendNamespace can read it and resolve newly-added fields against it.
export interface RoleDefinition {
	readonly description?: string;
	readonly permission: ReadonlyArray<Capability>;
	readonly deny?: ReadonlyArray<Capability>;
}

// ---- permission input (per operation: allow overrides the base, deny subtracts) ----

// Role tokens (named roles + reserved server/client/public) are plain strings here,
// validated against the namespace's roles at runtime. Typing them to the declared
// role names breaks State/Computed/Topic inference (co-inference), so it's deferred.
interface PermissionRule {
	readonly allow?: ReadonlyArray<string>;
	readonly deny?: ReadonlyArray<string>;
}
interface StatePermission {
	readonly read?: PermissionRule;
	readonly write?: PermissionRule;
}
interface ComputedPermission {
	readonly read?: PermissionRule;
}
interface TopicPermission {
	readonly subscribe?: PermissionRule;
	readonly publish?: PermissionRule;
}

// ---- permission resolved/baked (per operation: explicit allowed role list) ----

export interface ResolvedStatePermission {
	readonly read: ReadonlyArray<string>;
	readonly write: ReadonlyArray<string>;
}
export interface ResolvedComputedPermission {
	readonly read: ReadonlyArray<string>;
}
export interface ResolvedTopicPermission {
	readonly subscribe: ReadonlyArray<string>;
	readonly publish: ReadonlyArray<string>;
}

// ---- resolution ----

const expand = (
	tokens: ReadonlyArray<string>,
	namedRoles: ReadonlyArray<string>,
): Set<string> => {
	const result = new Set<string>();
	for (const token of tokens) {
		if (token === "client") {
			for (const role of namedRoles) {
				result.add(role);
			}
			result.add("public");
		} else {
			result.add(token);
		}
	}
	return result;
};

// Four passes: role base → field allow → role veto → field deny.
const resolveRule = (
	base: ReadonlySet<string>,
	rule: PermissionRule | undefined,
	veto: ReadonlySet<string>,
	namedRoles: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const allowed = rule?.allow ? expand(rule.allow, namedRoles) : new Set(base);
	for (const role of veto) {
		allowed.delete(role);
	}
	for (const role of expand(rule?.deny ?? [], namedRoles)) {
		allowed.delete(role);
	}
	return [...allowed].sort();
};

const rolesWith = (
	capability: Capability,
	roleCapabilities: ReadonlyMap<string, ReadonlySet<Capability>>,
): ReadonlySet<string> => {
	const holders = new Set<string>();
	for (const [role, capabilities] of roleCapabilities) {
		if (capabilities.has(capability)) {
			holders.add(role);
		}
	}
	return holders;
};

// ---- manifest ----

interface FieldManifest<
	Decoded,
	ResolvedPermission,
> extends FieldCodec<Decoded> {
	readonly permission: ResolvedPermission;
}

export interface NamespaceManifest<
	State extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
	Topic extends Record<string, Schema.Schema<any, any, never>>,
> {
	readonly namespace: string;
	readonly roles: Record<string, RoleDefinition>;
	readonly state: {
		[K in keyof State & string]: FieldManifest<
			Schema.Schema.Type<State[K]>,
			ResolvedStatePermission
		>;
	};
	readonly computed: {
		[K in keyof Computed & string]: FieldManifest<
			Schema.Schema.Type<Computed[K]>,
			ResolvedComputedPermission
		>;
	};
	readonly topic: {
		[K in keyof Topic & string]: FieldManifest<
			Schema.Schema.Type<Topic[K]>,
			ResolvedTopicPermission
		>;
	};
}

// ---- field option input ----

interface FieldOption<S extends Schema.Schema<any, any, never>, Permission> {
	readonly schema: [Schema.Schema.Encoded<S>] extends [JsonValue] ? S : never;
	readonly permission?: Permission;
}

interface FieldOptionLambda<Permission> extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: FieldOption<this["Target"], Permission>;
}
interface FieldManifestLambda<ResolvedPermission> extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: FieldManifest<
		Schema.Schema.Type<this["Target"]>,
		ResolvedPermission
	>;
}

export function defineNamespace<
	State extends Record<string, Schema.Schema<any, any, never>> = {},
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
	Topic extends Record<string, Schema.Schema<any, any, never>> = {},
>(
	namespace: string,
	def: {
		roles?: Record<string, RoleDefinition>;
		state?: {
			[K in keyof State & string]: FieldOption<State[K], StatePermission>;
		};
		computed?: {
			[K in keyof Computed & string]: FieldOption<
				Computed[K],
				ComputedPermission
			>;
		};
		topic?: {
			[K in keyof Topic & string]: FieldOption<Topic[K], TopicPermission>;
		};
	},
): NamespaceManifest<State, Computed, Topic> {
	const roleCapabilities = new Map<string, ReadonlySet<Capability>>();
	const roleDenials = new Map<string, ReadonlySet<Capability>>();
	const roles: Record<string, RoleDefinition> = {};
	if (def.roles) {
		for (const [name, definition] of Object.entries(def.roles)) {
			if (RESERVED_ROLE_SET.has(name)) {
				throw new Error(`Role "${name}" is reserved and cannot be declared`);
			}
			roleCapabilities.set(name, new Set(definition.permission));
			if (definition.deny) {
				roleDenials.set(name, new Set(definition.deny));
			}
			roles[name] = definition;
		}
	}
	const namedRoles = Object.keys(roles);

	const resolve = (capability: Capability, rule: PermissionRule | undefined) =>
		resolveRule(
			rolesWith(capability, roleCapabilities),
			rule,
			rolesWith(capability, roleDenials),
			namedRoles,
		);

	const state = mapValues<
		FieldOptionLambda<StatePermission>,
		FieldManifestLambda<ResolvedStatePermission>
	>()(def.state, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("state-read", option.permission?.read),
			write: resolve("state-write", option.permission?.write),
		},
	}));

	const computed = mapValues<
		FieldOptionLambda<ComputedPermission>,
		FieldManifestLambda<ResolvedComputedPermission>
	>()(def.computed, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("computed-read", option.permission?.read),
		},
	}));

	const topic = mapValues<
		FieldOptionLambda<TopicPermission>,
		FieldManifestLambda<ResolvedTopicPermission>
	>()(def.topic, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			subscribe: resolve("topic-subscribe", option.permission?.subscribe),
			publish: resolve("topic-publish", option.permission?.publish),
		},
	}));

	return {
		namespace,
		roles,
		state,
		computed,
		topic,
	};
}

// ---- extend input ----

// `schema` present → add (or redefine) a field; absent → override an existing field's
// permission only (its codec is kept).
interface ExtendStateOption {
	readonly schema?: Schema.Schema<any, any, never>;
	readonly permission?: StatePermission;
}
interface ExtendComputedOption {
	readonly schema?: Schema.Schema<any, any, never>;
	readonly permission?: ComputedPermission;
}
interface ExtendTopicOption {
	readonly schema?: Schema.Schema<any, any, never>;
	readonly permission?: TopicPermission;
}
interface ExtendDef<StateDef, ComputedDef, TopicDef> {
	readonly roles?: Record<string, RoleDefinition>;
	readonly state?: StateDef;
	readonly computed?: ComputedDef;
	readonly topic?: TopicDef;
}

// TODO: use type-fest
type Merge<Precedent, Added> = Omit<Precedent, keyof Added> & Added;

export function extendNamespace<
	PState extends Record<string, Schema.Schema<any, any, never>>,
	PComputed extends Record<string, Schema.Schema<any, any, never>>,
	PTopic extends Record<string, Schema.Schema<any, any, never>>,
	const StateDef extends Record<string, ExtendStateOption> = {},
	const ComputedDef extends Record<string, ExtendComputedOption> = {},
	const TopicDef extends Record<string, ExtendTopicOption> = {},
>(
	manifest: NamespaceManifest<PState, PComputed, PTopic>,
	def:
		| ExtendDef<StateDef, ComputedDef, TopicDef>
		| ((
				precedent: NamespaceManifest<PState, PComputed, PTopic>,
		  ) => ExtendDef<StateDef, ComputedDef, TopicDef>),
): NamespaceManifest<
	Merge<PState, AddedSchemas<StateDef>>,
	Merge<PComputed, AddedSchemas<ComputedDef>>,
	Merge<PTopic, AddedSchemas<TopicDef>>
> {
	const concrete = typeof def === "function" ? def(manifest) : def;

	// merge roles: precedent + this layer, accumulating permission and deny
	const roles: Record<string, RoleDefinition> = { ...manifest.roles };
	if (concrete.roles) {
		for (const [name, definition] of Object.entries(concrete.roles)) {
			if (RESERVED_ROLE_SET.has(name)) {
				throw new Error(`Role "${name}" is reserved and cannot be declared`);
			}
			const prev = roles[name];
			roles[name] = {
				permission: [
					...new Set([...(prev?.permission ?? []), ...definition.permission]),
				],
				deny: [...new Set([...(prev?.deny ?? []), ...(definition.deny ?? [])])],
			};
		}
	}

	const roleCapabilities = new Map<string, ReadonlySet<Capability>>();
	const roleDenials = new Map<string, ReadonlySet<Capability>>();
	for (const [name, definition] of Object.entries(roles)) {
		roleCapabilities.set(name, new Set(definition.permission));
		roleDenials.set(name, new Set(definition.deny ?? []));
	}
	const namedRoles = Object.keys(roles);

	// roles this layer newly grants a capability → retroactively added to existing baked lists
	const granted = new Map<string, ReadonlySet<Capability>>();
	for (const [name, definition] of Object.entries(concrete.roles ?? {})) {
		granted.set(name, new Set(definition.permission));
	}

	const resolve = (capability: Capability, rule: PermissionRule | undefined) =>
		resolveRule(
			rolesWith(capability, roleCapabilities),
			rule,
			rolesWith(capability, roleDenials),
			namedRoles,
		);

	const remap = (
		capability: Capability,
		current: ReadonlyArray<string>,
		rule: PermissionRule | undefined,
	) => {
		const base = new Set(current);
		for (const role of rolesWith(capability, granted)) {
			base.add(role);
		}
		return resolveRule(
			base,
			rule,
			rolesWith(capability, roleDenials),
			namedRoles,
		);
	};

	const stateRemap = mapValues<
		FieldManifestLambda<ResolvedStatePermission>,
		FieldManifestLambda<ResolvedStatePermission>
	>()(manifest.state, (field, name) => {
		const override = concrete.state?.[name];
		return {
			...field,
			permission: {
				read: remap(
					"state-read",
					field.permission.read,
					override?.permission?.read,
				),
				write: remap(
					"state-write",
					field.permission.write,
					override?.permission?.write,
				),
			},
		};
	});

	const stateAdded = mapSchemaValues<
		ExtendStateOption,
		FieldManifestLambda<ResolvedStatePermission>
	>()(concrete.state, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("state-read", option.permission?.read),
			write: resolve("state-write", option.permission?.write),
		},
	}));
	const state = mergeRecords<
		NamespaceManifest<
			Merge<PState, AddedSchemas<StateDef>>,
			PComputed,
			PTopic
		>["state"]
	>(stateRemap, stateAdded);

	const computedRemap = mapValues<
		FieldManifestLambda<ResolvedComputedPermission>,
		FieldManifestLambda<ResolvedComputedPermission>
	>()(manifest.computed, (field, name) => {
		const override = concrete.computed?.[name];
		return {
			...field,
			permission: {
				read: remap(
					"computed-read",
					field.permission.read,
					override?.permission?.read,
				),
			},
		};
	});
	const computedAdded = mapSchemaValues<
		ExtendComputedOption,
		FieldManifestLambda<ResolvedComputedPermission>
	>()(concrete.computed, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("computed-read", option.permission?.read),
		},
	}));
	const computed = mergeRecords<
		NamespaceManifest<
			PState,
			Merge<PComputed, AddedSchemas<ComputedDef>>,
			PTopic
		>["computed"]
	>(computedRemap, computedAdded);

	const topicRemap = mapValues<
		FieldManifestLambda<ResolvedTopicPermission>,
		FieldManifestLambda<ResolvedTopicPermission>
	>()(manifest.topic, (field, name) => {
		const override = concrete.topic?.[name];
		return {
			...field,
			permission: {
				subscribe: remap(
					"topic-subscribe",
					field.permission.subscribe,
					override?.permission?.subscribe,
				),
				publish: remap(
					"topic-publish",
					field.permission.publish,
					override?.permission?.publish,
				),
			},
		};
	});
	const topicAdded = mapSchemaValues<
		ExtendTopicOption,
		FieldManifestLambda<ResolvedTopicPermission>
	>()(concrete.topic, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			subscribe: resolve("topic-subscribe", option.permission?.subscribe),
			publish: resolve("topic-publish", option.permission?.publish),
		},
	}));
	const topic = mergeRecords<
		NamespaceManifest<
			PState,
			PComputed,
			Merge<PTopic, AddedSchemas<TopicDef>>
		>["topic"]
	>(topicRemap, topicAdded);

	return { namespace: manifest.namespace, roles, state, computed, topic };
}

// function filterValuesBySchemaExistance<
// 	In extends Record<
// 		string,
// 		{ readonly schema?: Schema.Schema<any, any, never> }
// 	>,
// >(
// 	obj?: In,
// ): {
// 	readonly [K in keyof In as [In[K]["schema"]] extends [
// 		Schema.Schema<any, any, never>,
// 	]
// 		? K
// 		: never]: Omit<In[K], "schema"> & { schema: NonNullable<In[K]["schema"]> };
// } {
// 	const result: any = {};
// 	for (const key in obj) {
// 		const value = obj[key];
// 		if (typeof value?.schema !== "undefined") {
// 			result[key] = {
// 				...obj[key],
// 				schema: value.schema,
// 			};
// 		}
// 	}
// 	return result;
// }
