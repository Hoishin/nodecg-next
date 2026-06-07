import {
	type AddedSchemas,
	mapSchemaValues,
	mapValues,
	mergeRecords,
} from "@nodecg/internal";
import { Data, Effect, type HKT, Schema } from "effect";
import type { JsonValue } from "type-fest";

import { RESERVED_ROLE, RESERVED_ROLE_SET, RoleName } from "./role.ts";

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

export type RoleCapability =
	| "state-read"
	| "state-write"
	| "computed-read"
	| "topic-subscribe"
	| "topic-publish";

export interface RoleArg {
	readonly description?: string;
	readonly permission: ReadonlyArray<RoleCapability>;
}
export interface PermissionRuleArg {
	readonly allow?: readonly string[];
	readonly deny?: readonly string[];
}
export interface PermissionArg {
	readonly read?: PermissionRuleArg;
	readonly write?: PermissionRuleArg;
}
export interface ReadOnlyPermissionArg {
	readonly read?: PermissionRuleArg;
}

export interface RoleManifest {
	readonly name: RoleName;
	readonly description?: string;
	readonly capabilities: ReadonlySet<RoleCapability>;
}
export interface ResolvedPermission {
	readonly read: ReadonlySet<RoleName>;
	readonly write: ReadonlySet<RoleName>;
}

const expandClientRoles = (
	roles: ReadonlyArray<RoleName>,
	namedRoles: ReadonlySet<RoleName>,
): Set<RoleName> => {
	const result = new Set<RoleName>();
	for (const role of roles) {
		if (role === RESERVED_ROLE.client) {
			for (const role of namedRoles) {
				result.add(role);
			}
		} else {
			result.add(role);
		}
	}
	return result;
};

const resolveFieldAllowedRoles = (
	base: ReadonlySet<RoleName>,
	rule: PermissionRuleArg | undefined,
	namedRoles: ReadonlySet<RoleName>,
): ReadonlySet<RoleName> => {
	let result = new Set(base);
	// If allow exists, override base roles
	if (rule?.allow) {
		result = expandClientRoles(rule.allow.map(RoleName), namedRoles);
	}
	// Remove explicitly denied roles from the list
	if (rule?.deny) {
		result = result.difference(
			expandClientRoles(rule.deny.map(RoleName), namedRoles),
		);
	}
	return result;
};

const findRolesWithCapability = (
	capability: RoleCapability,
	roles: ReadonlyMap<RoleName, RoleManifest>,
): ReadonlySet<RoleName> => {
	const holders = new Set<RoleName>();
	for (const [role, roleManifest] of roles) {
		if (roleManifest.capabilities.has(capability)) {
			holders.add(role);
		}
	}
	return holders;
};

export interface FieldManifest<Decoded> {
	readonly name: string;
	readonly encode: (
		value: Decoded,
	) => Effect.Effect<JsonValue, StateEncodeError>;
	readonly decode: (
		value: JsonValue,
	) => Effect.Effect<Decoded, StateDecodeError>;
	readonly permission: ResolvedPermission;
}

export interface NamespaceManifest<
	State extends Record<string, Schema.Schema<any, any, never>>,
	Computed extends Record<string, Schema.Schema<any, any, never>>,
	Topic extends Record<string, Schema.Schema<any, any, never>>,
> {
	readonly namespace: string;
	// TODO: make it private, provide helper for manual permission check
	readonly roles: Map<RoleName, RoleManifest>;
	readonly state: {
		[K in keyof State & string]: FieldManifest<Schema.Schema.Type<State[K]>>;
	};
	readonly computed: {
		[K in keyof Computed & string]: FieldManifest<
			Schema.Schema.Type<Computed[K]>
		>;
	};
	readonly topic: {
		[K in keyof Topic & string]: FieldManifest<Schema.Schema.Type<Topic[K]>>;
	};
}

interface FieldOption<
	S extends Schema.Schema<any, any, never>,
	P extends PermissionArg | ReadOnlyPermissionArg,
> {
	readonly schema: [Schema.Schema.Encoded<S>] extends [JsonValue] ? S : never;
	readonly permission?: P;
}

interface FieldOptionLambda<P extends PermissionArg | ReadOnlyPermissionArg>
	extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: FieldOption<this["Target"], P>;
}
interface FieldManifestLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: FieldManifest<Schema.Schema.Type<this["Target"]>>;
}

function implementCodec<S extends Schema.Schema<any, JsonValue, never>>(
	name: string,
	schema: S,
) {
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

export function defineNamespace<
	State extends Record<string, Schema.Schema<any, any, never>> = {},
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
	Topic extends Record<string, Schema.Schema<any, any, never>> = {},
>(
	namespace: string,
	defineOption: {
		roles?: Record<string, RoleArg>;
		state?: {
			[K in keyof State & string]: FieldOption<State[K], PermissionArg>;
		};
		computed?: {
			[K in keyof Computed & string]: FieldOption<
				Computed[K],
				ReadOnlyPermissionArg
			>;
		};
		topic?: {
			[K in keyof Topic & string]: FieldOption<Topic[K], PermissionArg>;
		};
	},
): NamespaceManifest<State, Computed, Topic> {
	const roles = new Map<RoleName, RoleManifest>();

	if (defineOption.roles) {
		for (const [key, roleArg] of Object.entries(defineOption.roles)) {
			const roleName = RoleName(key);
			if (RESERVED_ROLE_SET.has(roleName)) {
				throw new Error(
					`Role "${roleName}" is reserved and cannot be declared`,
				);
			}
			roles.set(roleName, {
				name: roleName,
				description: roleArg.description,
				capabilities: new Set(roleArg.permission),
			});
		}
	}
	const namedRoles = new Set(roles.keys());

	const resolve = (
		capability: RoleCapability,
		rule: PermissionRuleArg | undefined,
	) =>
		resolveFieldAllowedRoles(
			findRolesWithCapability(capability, roles),
			rule,
			namedRoles,
		);

	const state = mapValues<
		FieldOptionLambda<PermissionArg>,
		FieldManifestLambda
	>()(defineOption.state, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("state-read", option.permission?.read),
			write: resolve("state-write", option.permission?.write),
		},
	}));

	const computed = mapValues<
		FieldOptionLambda<ReadOnlyPermissionArg>,
		FieldManifestLambda
	>()(defineOption.computed, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("computed-read", option.permission?.read),
			write: new Set(),
		},
	}));

	const topic = mapValues<
		FieldOptionLambda<PermissionArg>,
		FieldManifestLambda
	>()(defineOption.topic, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("topic-subscribe", option.permission?.read),
			write: resolve("topic-publish", option.permission?.write),
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

/** extend **/

interface ExtendFieldOption<P extends PermissionArg | ReadOnlyPermissionArg> {
	readonly schema?: Schema.Schema<any, any, never>;
	readonly permission?: P;
}

type Override<Precedent, Added> = Omit<Precedent, keyof Added> & Added;

export function extendNamespace<
	PState extends Record<string, Schema.Schema<any, any, never>>,
	PComputed extends Record<string, Schema.Schema<any, any, never>>,
	PTopic extends Record<string, Schema.Schema<any, any, never>>,
	const EState extends Record<string, ExtendFieldOption<PermissionArg>> = {},
	const EComputed extends Record<
		string,
		ExtendFieldOption<ReadOnlyPermissionArg>
	> = {},
	const ETopic extends Record<string, ExtendFieldOption<PermissionArg>> = {},
>(
	manifest: NamespaceManifest<PState, PComputed, PTopic>,
	extendOptionOrFn:
		| {
				readonly roles?: Record<string, RoleArg>;
				readonly state?: EState;
				readonly computed?: EComputed;
				readonly topic?: ETopic;
		  }
		| ((precedent: NamespaceManifest<PState, PComputed, PTopic>) => {
				readonly roles?: Record<string, RoleArg>;
				readonly state?: EState;
				readonly computed?: EComputed;
				readonly topic?: ETopic;
		  }),
): NamespaceManifest<
	Override<PState, AddedSchemas<EState>>,
	Override<PComputed, AddedSchemas<EComputed>>,
	Override<PTopic, AddedSchemas<ETopic>>
> {
	const extendOption =
		typeof extendOptionOrFn === "function"
			? extendOptionOrFn(manifest)
			: extendOptionOrFn;

	// merge roles
	const roles = new Map(manifest.roles);
	if (extendOption.roles) {
		for (const [key, arg] of Object.entries(extendOption.roles)) {
			const roleName = RoleName(key);
			if (RESERVED_ROLE_SET.has(roleName)) {
				throw new Error(
					`Role "${roleName}" is reserved and cannot be declared`,
				);
			}
			const prev = roles.get(roleName);
			roles.set(roleName, {
				name: roleName,
				description: arg.description ?? prev?.description,
				capabilities: new Set(arg.permission),
			});
		}
	}

	const namedRoles = new Set(roles.keys());

	const granted = new Map<RoleName, RoleManifest>();
	for (const key of Object.keys(extendOption.roles ?? {})) {
		const roleName = RoleName(key);
		const role = roles.get(roleName);
		if (role) {
			granted.set(roleName, role);
		}
	}

	const resolve = (
		capability: RoleCapability,
		rule: PermissionRuleArg | undefined,
	) =>
		resolveFieldAllowedRoles(
			findRolesWithCapability(capability, roles),
			rule,
			namedRoles,
		);

	const remap = (
		capability: RoleCapability,
		current: ReadonlySet<RoleName>,
		rule: PermissionRuleArg | undefined,
	) => {
		const base = new Set(current);
		for (const [role, roleManifest] of granted) {
			if (roleManifest.capabilities.has(capability)) {
				base.add(role);
			} else {
				base.delete(role);
			}
		}
		return resolveFieldAllowedRoles(base, rule, namedRoles);
	};

	const stateRemap = mapValues<FieldManifestLambda, FieldManifestLambda>()(
		manifest.state,
		(field, name) => {
			const override = extendOption.state?.[name];
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
		},
	);

	const stateAdded = mapSchemaValues<
		ExtendFieldOption<PermissionArg>,
		FieldManifestLambda
	>()(extendOption.state, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("state-read", option.permission?.read),
			write: resolve("state-write", option.permission?.write),
		},
	}));
	const state = mergeRecords<
		NamespaceManifest<
			Override<PState, AddedSchemas<EState>>,
			PComputed,
			PTopic
		>["state"]
	>(stateRemap, stateAdded);

	const computedRemap = mapValues<FieldManifestLambda, FieldManifestLambda>()(
		manifest.computed,
		(field, name) => {
			const override = extendOption.computed?.[name];
			return {
				...field,
				permission: {
					read: remap(
						"computed-read",
						field.permission.read,
						override?.permission?.read,
					),
					write: new Set(),
				},
			};
		},
	);
	const computedAdded = mapSchemaValues<
		ExtendFieldOption<ReadOnlyPermissionArg>,
		FieldManifestLambda
	>()(extendOption.computed, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("computed-read", option.permission?.read),
			write: new Set(),
		},
	}));
	const computed = mergeRecords<
		NamespaceManifest<
			PState,
			Override<PComputed, AddedSchemas<EComputed>>,
			PTopic
		>["computed"]
	>(computedRemap, computedAdded);

	const topicRemap = mapValues<FieldManifestLambda, FieldManifestLambda>()(
		manifest.topic,
		(field, name) => {
			const override = extendOption.topic?.[name];
			return {
				...field,
				permission: {
					read: remap(
						"topic-subscribe",
						field.permission.read,
						override?.permission?.read,
					),
					write: remap(
						"topic-publish",
						field.permission.write,
						override?.permission?.write,
					),
				},
			};
		},
	);
	const topicAdded = mapSchemaValues<
		ExtendFieldOption<PermissionArg>,
		FieldManifestLambda
	>()(extendOption.topic, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("topic-subscribe", option.permission?.read),
			write: resolve("topic-publish", option.permission?.write),
		},
	}));
	const topic = mergeRecords<
		NamespaceManifest<
			PState,
			PComputed,
			Override<PTopic, AddedSchemas<ETopic>>
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
