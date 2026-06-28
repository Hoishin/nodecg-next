import {
	RESERVED_ROLE,
	RESERVED_ROLE_SET,
	RoleName,
	USABLE_RESERVED_ROLE_SET,
} from "@nodecg/internal";
import {
	type AddedSchemas,
	mapSchemaValues,
	mapValues,
	mergeRecords,
} from "@nodecg/internal/utils";
import { Data, Effect, type HKT, Schema } from "effect";
import type { JsonValue } from "type-fest";

import {
	buildPermission,
	type PermissionArg,
	type PermissionRuleArg,
	type ReadOnlyPermissionArg,
	type ResolvedPermission,
	type RoleArg,
	type RoleCapability,
	type RoleManifest,
} from "./role.ts";

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

export interface FieldManifest<D> {
	readonly name: string;
	readonly encode: (value: D) => Effect.Effect<JsonValue, StateEncodeError>;
	readonly decode: (value: JsonValue) => Effect.Effect<D, StateDecodeError>;
	readonly permission: ResolvedPermission;
}

export interface NamespaceManifest<
	State extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
> {
	readonly namespace: string;

	// TODO: make it private, provide helper for manual permission check
	readonly roles: Map<RoleName, RoleManifest>;

	readonly state: {
		[K in keyof State & string]: FieldManifest<State[K]>;
	};
	readonly computed: {
		[K in keyof Computed & string]: FieldManifest<Computed[K]>;
	};
	readonly topic: {
		[K in keyof Topic & string]: FieldManifest<Topic[K]>;
	};
}

interface FieldOption<
	S extends Schema.Schema<any, any, never>,
	P extends PermissionArg<string> | ReadOnlyPermissionArg<string>,
> {
	readonly schema: [Schema.Schema.Encoded<S>] extends [JsonValue] ? S : never;
	readonly permission?: P;
}

interface FieldOptionLambda<
	P extends PermissionArg<string> | ReadOnlyPermissionArg<string>,
>
	extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: FieldOption<this["Target"], P>;
}
interface FieldManifestFromSchemaLambda extends HKT.TypeLambda {
	readonly Target: Schema.Schema<any, any, never>;
	readonly type: FieldManifest<Schema.Schema.Type<this["Target"]>>;
}
interface FieldManifestLambda extends HKT.TypeLambda {
	readonly type: FieldManifest<this["Target"]>;
}

function implementCodec<D, E extends JsonValue>(
	name: string,
	schema: Schema.Schema<D, E>,
) {
	return {
		name,
		encode: Effect.fn("encode")(function* (value: D) {
			return yield* Schema.encode(schema)(value).pipe(
				Effect.catchTag(
					"ParseError",
					(error) =>
						new StateEncodeError({ fieldName: name, value, cause: error }),
				),
			);
		}),
		decode: Effect.fn("decode")(function* (value: E) {
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
	rule: PermissionRuleArg<string> | undefined,
	namedRoles: ReadonlySet<RoleName>,
): ReadonlySet<RoleName> => {
	let result = new Set(base);
	if (rule?.allow) {
		result = expandClientRoles(rule.allow.map(RoleName), namedRoles);
	}
	if (rule?.deny) {
		result = result.difference(
			expandClientRoles(rule.deny.map(RoleName), namedRoles),
		);
	}
	return result;
};

type FieldPermissionOptions = {
	readonly permission?: {
		readonly read?: PermissionRuleArg<string>;
		readonly write?: PermissionRuleArg<string>;
	};
};

const validatePermissionTokens = (
	group: "state" | "computed" | "topic",
	fields: Readonly<Record<string, FieldPermissionOptions>> | undefined,
	namedRoles: ReadonlySet<RoleName>,
): void => {
	for (const [name, field] of Object.entries(fields ?? {})) {
		for (const operation of ["read", "write"] as const) {
			const rule = field.permission?.[operation];
			for (const kind of ["allow", "deny"] as const) {
				for (const token of rule?.[kind] ?? []) {
					const roleName = RoleName(token);
					if (
						!namedRoles.has(roleName) &&
						!USABLE_RESERVED_ROLE_SET.has(roleName)
					) {
						throw new Error(
							`Unknown role "${token}" in ${group} "${name}" ${operation}.${kind}`,
						);
					}
				}
			}
		}
	}
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

export function defineNamespace<
	const Roles extends Record<string, RoleArg> = {},
	State extends Record<string, Schema.Schema<any, any, never>> = {},
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
	Topic extends Record<string, Schema.Schema<any, any, never>> = {},
>(
	namespace: string,
	defineOption: {
		roles?: Roles;
		state?: {
			[K in keyof State & string]: FieldOption<
				State[K],
				PermissionArg<keyof Roles & string>
			>;
		};
		computed?: {
			[K in keyof Computed & string]: FieldOption<
				Computed[K],
				ReadOnlyPermissionArg<keyof Roles & string>
			>;
		};
		topic?: {
			[K in keyof Topic & string]: FieldOption<
				Topic[K],
				PermissionArg<keyof Roles & string>
			>;
		};
	},
): NamespaceManifest<
	{ [K in keyof State]: Schema.Schema.Type<State[K]> },
	{ [K in keyof Computed]: Schema.Schema.Type<Computed[K]> },
	{ [K in keyof Topic]: Schema.Schema.Type<Topic[K]> }
> {
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

	validatePermissionTokens("state", defineOption.state, namedRoles);
	validatePermissionTokens("computed", defineOption.computed, namedRoles);
	validatePermissionTokens("topic", defineOption.topic, namedRoles);

	const resolve = (
		capability: RoleCapability,
		rule: PermissionRuleArg<keyof Roles & string> | undefined,
	) =>
		resolveFieldAllowedRoles(
			findRolesWithCapability(capability, roles),
			rule,
			namedRoles,
		);

	const state = mapValues<
		FieldOptionLambda<PermissionArg<keyof Roles & string>>,
		FieldManifestFromSchemaLambda
	>((option, name) => ({
		...implementCodec(name, option.schema),
		permission: buildPermission(
			resolve("state-read", option.permission?.read),
			resolve("state-write", option.permission?.write),
			true,
		),
	}))(defineOption.state);

	const computed = mapValues<
		FieldOptionLambda<ReadOnlyPermissionArg<keyof Roles & string>>,
		FieldManifestFromSchemaLambda
	>((option, name) => ({
		...implementCodec(name, option.schema),
		permission: buildPermission(
			resolve("computed-read", option.permission?.read),
			new Set(),
			false,
		),
	}))(defineOption.computed);

	const topic = mapValues<
		FieldOptionLambda<PermissionArg<keyof Roles & string>>,
		FieldManifestFromSchemaLambda
	>((option, name) => ({
		...implementCodec(name, option.schema),
		permission: buildPermission(
			resolve("topic-subscribe", option.permission?.read),
			resolve("topic-publish", option.permission?.write),
			true,
		),
	}))(defineOption.topic);

	return {
		namespace,
		roles,
		state,
		computed,
		topic,
	};
}

/** extend **/

interface ExtendFieldOption<
	P extends PermissionArg<string> | ReadOnlyPermissionArg<string>,
> {
	readonly schema?: Schema.Schema<any, any, never>;
	readonly permission?: P;
}

type Override<Precedent, Added> = Omit<Precedent, keyof Added> & Added;

type AddedDecoded<In> = {
	readonly [K in keyof AddedSchemas<In>]: Schema.Schema.Type<
		AddedSchemas<In>[K]
	>;
};

export function extendNamespace<
	PState extends Record<string, unknown>,
	PComputed extends Record<string, unknown>,
	PTopic extends Record<string, unknown>,
	const EState extends Record<
		string,
		ExtendFieldOption<PermissionArg<string>>
	> = {},
	const EComputed extends Record<
		string,
		ExtendFieldOption<ReadOnlyPermissionArg<string>>
	> = {},
	const ETopic extends Record<
		string,
		ExtendFieldOption<PermissionArg<string>>
	> = {},
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
	Override<PState, AddedDecoded<EState>>,
	Override<PComputed, AddedDecoded<EComputed>>,
	Override<PTopic, AddedDecoded<ETopic>>
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

	validatePermissionTokens("state", extendOption.state, namedRoles);
	validatePermissionTokens("computed", extendOption.computed, namedRoles);
	validatePermissionTokens("topic", extendOption.topic, namedRoles);

	const resolve = (
		capability: RoleCapability,
		rule: PermissionRuleArg<string> | undefined,
	) =>
		resolveFieldAllowedRoles(
			findRolesWithCapability(capability, roles),
			rule,
			namedRoles,
		);

	const remap = (
		capability: RoleCapability,
		current: ReadonlySet<RoleName>,
		rule: PermissionRuleArg<string> | undefined,
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

	const stateRemap = mapValues<FieldManifestLambda, FieldManifestLambda>(
		(field, name) => {
			const override = extendOption.state?.[name];
			return {
				name: field.name,
				decode: field.decode,
				encode: field.encode,
				permission: buildPermission(
					remap(
						"state-read",
						field.permission.read,
						override?.permission?.read,
					),
					remap(
						"state-write",
						field.permission.write,
						override?.permission?.write,
					),
					true,
				),
			};
		},
	)(manifest.state);

	const stateAdded = mapSchemaValues<
		ExtendFieldOption<PermissionArg<string>>,
		FieldManifestLambda
	>()(extendOption.state, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: buildPermission(
			resolve("state-read", option.permission?.read),
			resolve("state-write", option.permission?.write),
			true,
		),
	}));
	const state = mergeRecords<
		NamespaceManifest<
			Override<PState, AddedDecoded<EState>>,
			PComputed,
			PTopic
		>["state"]
	>(stateRemap, stateAdded);

	const computedRemap = mapValues<FieldManifestLambda, FieldManifestLambda>(
		(field, name) => {
			const override = extendOption.computed?.[name];
			return {
				name: field.name,
				decode: field.decode,
				encode: field.encode,
				permission: buildPermission(
					remap(
						"computed-read",
						field.permission.read,
						override?.permission?.read,
					),
					new Set(),
					false,
				),
			};
		},
	)(manifest.computed);
	const computedAdded = mapSchemaValues<
		ExtendFieldOption<ReadOnlyPermissionArg<string>>,
		FieldManifestLambda
	>()(extendOption.computed, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: buildPermission(
			resolve("computed-read", option.permission?.read),
			new Set(),
			false,
		),
	}));
	const computed = mergeRecords<
		NamespaceManifest<
			PState,
			Override<PComputed, AddedDecoded<EComputed>>,
			PTopic
		>["computed"]
	>(computedRemap, computedAdded);

	const topicRemap = mapValues<FieldManifestLambda, FieldManifestLambda>(
		(field, name) => {
			const override = extendOption.topic?.[name];
			return {
				name: field.name,
				encode: field.encode,
				decode: field.decode,
				permission: buildPermission(
					remap(
						"topic-subscribe",
						field.permission.read,
						override?.permission?.read,
					),
					remap(
						"topic-publish",
						field.permission.write,
						override?.permission?.write,
					),
					true,
				),
			};
		},
	)(manifest.topic);
	const topicAdded = mapSchemaValues<
		ExtendFieldOption<PermissionArg<string>>,
		FieldManifestLambda
	>()(extendOption.topic, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: buildPermission(
			resolve("topic-subscribe", option.permission?.read),
			resolve("topic-publish", option.permission?.write),
			true,
		),
	}));
	const topic = mergeRecords<
		NamespaceManifest<
			PState,
			PComputed,
			Override<PTopic, AddedDecoded<ETopic>>
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
