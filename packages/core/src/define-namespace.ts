import {
	type AddedSchemas,
	mapSchemaValues,
	mapValues,
	mergeRecords,
	RESERVED_ROLE,
	RESERVED_ROLE_SET,
	RoleName,
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

// TODO: add tests for the restriction, both runtime and types
export interface PermissionRuleArg<InputRole extends string> {
	readonly allow?: readonly (InputRole | keyof typeof RESERVED_ROLE)[];
	readonly deny?: readonly (InputRole | keyof typeof RESERVED_ROLE)[];
}
export interface PermissionArg<InputRole extends string> {
	readonly read?: PermissionRuleArg<InputRole>;
	readonly write?: PermissionRuleArg<InputRole>;
}
export interface ReadOnlyPermissionArg<InputRole extends string> {
	readonly read?: PermissionRuleArg<InputRole>;
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
	rule: PermissionRuleArg<string> | undefined,
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
		permission: {
			read: resolve("state-read", option.permission?.read),
			write: resolve("state-write", option.permission?.write),
		},
	}))(defineOption.state);

	const computed = mapValues<
		FieldOptionLambda<ReadOnlyPermissionArg<keyof Roles & string>>,
		FieldManifestFromSchemaLambda
	>((option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("computed-read", option.permission?.read),
			write: new Set(),
		},
	}))(defineOption.computed);

	const topic = mapValues<
		FieldOptionLambda<PermissionArg<keyof Roles & string>>,
		FieldManifestFromSchemaLambda
	>((option, name) => ({
		...implementCodec(name, option.schema),
		permission: {
			read: resolve("topic-subscribe", option.permission?.read),
			write: resolve("topic-publish", option.permission?.write),
		},
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
	)(manifest.state);

	const stateAdded = mapSchemaValues<
		ExtendFieldOption<PermissionArg<string>>,
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
			Override<PState, AddedDecoded<EState>>,
			PComputed,
			PTopic
		>["state"]
	>(stateRemap, stateAdded);

	const computedRemap = mapValues<FieldManifestLambda, FieldManifestLambda>(
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
	)(manifest.computed);
	const computedAdded = mapSchemaValues<
		ExtendFieldOption<ReadOnlyPermissionArg<string>>,
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
			Override<PComputed, AddedDecoded<EComputed>>,
			PTopic
		>["computed"]
	>(computedRemap, computedAdded);

	const topicRemap = mapValues<FieldManifestLambda, FieldManifestLambda>(
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
	)(manifest.topic);
	const topicAdded = mapSchemaValues<
		ExtendFieldOption<PermissionArg<string>>,
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
