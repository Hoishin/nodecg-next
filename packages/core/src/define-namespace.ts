import {
	isUndeclarableRole,
	PRINCIPAL,
	PRINCIPAL_BY_NAME,
	PrincipalNameSchema,
	RoleName,
	type Principal,
	type PrincipalName,
	type UndeclarableRoleName,
} from "@nodecg/internal";
import {
	type AddedRpcSchemas,
	type AddedSchemas,
	mapRpcValues,
	mapSchemaValues,
	mapValues,
	mergeRecords,
} from "@nodecg/internal/utils";
import { Data, Effect, type HKT, Schema } from "effect";
import type { JsonValue } from "type-fest";

import {
	computedPermission,
	replicantPermission,
	ROLE_CAPABILITY,
	rpcPermission,
	topicPermission,
	type Access,
	type Grant,
	type PermissionArg,
	type PrincipalsArg,
	type PermissionRuleArg,
	type ReadOnlyPermissionArg,
	type ResolvedPermission,
	type RoleArg,
	type RoleCapability,
	type RoleManifest,
	type WriteOnlyPermissionArg,
} from "./role.ts";

export class FieldEncodeError extends Data.TaggedError("FieldEncodeError")<{
	readonly fieldName: string;
	readonly value: unknown;
	readonly cause: Error;
}> {
	override readonly message = `Failed to encode replicant "${this.fieldName}": ${this.cause.message}`;
}

export class FieldDecodeError extends Data.TaggedError("FieldDecodeError")<{
	readonly fieldName: string;
	readonly value: JsonValue;
	readonly cause: Error;
}> {
	override readonly message = `Failed to decode replicant "${this.fieldName}": ${this.cause.message}`;
}

export interface FieldCodec<D> {
	readonly encode: (value: D) => Effect.Effect<JsonValue, FieldEncodeError>;
	readonly decode: (value: JsonValue) => Effect.Effect<D, FieldDecodeError>;
}

export interface FieldManifest<D> extends FieldCodec<D> {
	readonly name: string;
	readonly permission: ResolvedPermission;
}

export interface RpcFieldManifest<Request, Response> {
	readonly name: string;
	readonly request: FieldCodec<Request>;
	readonly response: FieldCodec<Response>;
	readonly permission: ResolvedPermission;
}

const manifestRolesKey = Symbol("manifestRolesKey");

export interface NamespaceManifest<
	Replicant extends Record<string, unknown>,
	Computed extends Record<string, unknown>,
	Topic extends Record<string, unknown>,
	Rpc extends Record<
		string,
		{ readonly request: unknown; readonly response: unknown }
	> = {},
> {
	readonly namespace: string;
	readonly [manifestRolesKey]: RoleRegistry;

	readonly replicant: {
		[K in keyof Replicant & string]: FieldManifest<Replicant[K]>;
	};
	readonly computed: {
		[K in keyof Computed & string]: FieldManifest<Computed[K]>;
	};
	readonly topic: {
		[K in keyof Topic & string]: FieldManifest<Topic[K]>;
	};
	readonly rpc: {
		[K in keyof Rpc & string]: RpcFieldManifest<
			Rpc[K]["request"],
			Rpc[K]["response"]
		>;
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

type RpcSchemaPair = {
	readonly request: Schema.Schema<any, any, never>;
	readonly response: Schema.Schema<any, any, never>;
};

interface RpcFieldOption<P extends WriteOnlyPermissionArg<string>> {
	readonly schema: RpcSchemaPair;
	readonly permission?: P;
}

interface RpcFieldManifestFromSchemaLambda extends HKT.TypeLambda {
	readonly Target: RpcSchemaPair;
	readonly type: RpcFieldManifest<
		Schema.Schema.Type<this["Target"]["request"]>,
		Schema.Schema.Type<this["Target"]["response"]>
	>;
}
interface RpcFieldManifestLambda extends HKT.TypeLambda {
	readonly Target: { readonly request: unknown; readonly response: unknown };
	readonly type: RpcFieldManifest<
		this["Target"]["request"],
		this["Target"]["response"]
	>;
}

function makeCodec<D, E extends JsonValue>(
	name: string,
	schema: Schema.Schema<D, E>,
) {
	return {
		encode: Effect.fn("encode")(function* (value: D) {
			return yield* Schema.encode(schema)(value).pipe(
				Effect.catchTag(
					"ParseError",
					(error) =>
						new FieldEncodeError({ fieldName: name, value, cause: error }),
				),
			);
		}),
		decode: Effect.fn("decode")(function* (value: E) {
			return yield* Schema.decode(schema)(value).pipe(
				Effect.catchTag(
					"ParseError",
					(error) =>
						new FieldDecodeError({ fieldName: name, value, cause: error }),
				),
			);
		}),
	};
}

function implementCodec<D, E extends JsonValue>(
	name: string,
	schema: Schema.Schema<D, E>,
) {
	return { name, ...makeCodec(name, schema) };
}

interface RoleRegistry {
	readonly roles: Map<RoleName, RoleManifest>;
	readonly principals: Map<Principal, RoleManifest>;
}

interface DeclaredTokens {
	readonly roles: ReadonlySet<RoleName>;
	readonly principals: ReadonlySet<PrincipalName>;
}

type AccessBuilder = {
	[K in PrincipalName]?: Grant;
} & {
	roles: Set<RoleName>;
	rolesDenied: Set<RoleName>;
};

const initializeAccess = (): AccessBuilder => ({
	roles: new Set(),
	rolesDenied: new Set(),
});

const updateAccess = (access: Access): AccessBuilder => ({
	...access,
	roles: new Set(access.roles),
	rolesDenied: new Set(access.rolesDenied),
});

const writeRule = (
	access: AccessBuilder,
	rule: PermissionRuleArg<string> | undefined,
): void => {
	if (typeof rule === "undefined") {
		return;
	}
	if (rule.allow) {
		access.roles = new Set(rule.allow.map(RoleName));
		// an allow lifts a denial it names
		access.rolesDenied = access.rolesDenied.difference(access.roles);
	}
	if (rule.deny) {
		const denied = new Set(rule.deny.map(RoleName));
		access.roles = access.roles.difference(denied);
		access.rolesDenied = access.rolesDenied.union(denied);
	}
	for (const principal of PrincipalNameSchema.literals) {
		const grant = rule[principal];
		if (typeof grant !== "undefined") {
			access[principal] = grant;
		}
	}
};

/**
 * A fresh field (no precedent) replays every registry row onto a seed;
 * an inherited field replays only the tokens this layer re-declared.
 */
const resolveAccess = (
	registry: RoleRegistry,
	declared: DeclaredTokens,
	capability: RoleCapability,
	precedent: Access | undefined,
	rule: PermissionRuleArg<string> | undefined,
): Access => {
	const access = precedent ? updateAccess(precedent) : initializeAccess();
	const roles = precedent ? declared.roles : registry.roles.keys();
	for (const role of roles) {
		if (access.rolesDenied.has(role)) {
			// a field-level deny stands
			continue;
		}
		if (registry.roles.get(role)?.capabilities.has(capability)) {
			access.roles.add(role);
		} else {
			access.roles.delete(role);
		}
	}
	const principals = precedent
		? declared.principals
		: PrincipalNameSchema.literals;
	for (const name of principals) {
		if (access[name] === "deny") {
			continue;
		}
		if (
			registry.principals.get(PRINCIPAL[name])?.capabilities.has(capability)
		) {
			access[name] = "allow";
		} else {
			access[name] = undefined;
		}
	}
	writeRule(access, rule);
	return access;
};

type FieldPermissionOptions = {
	readonly permission?: {
		readonly read?: PermissionRuleArg<string>;
		readonly write?: PermissionRuleArg<string>;
	};
};

const validatePermissionTokens = (
	group: "replicant" | "computed" | "topic" | "rpc",
	fields: Readonly<Record<string, FieldPermissionOptions>> | undefined,
	roles: ReadonlyMap<RoleName, RoleManifest>,
): void => {
	for (const [name, field] of Object.entries(fields ?? {})) {
		for (const operation of ["read", "write"] as const) {
			const rule = field.permission?.[operation];
			for (const kind of ["allow", "deny"] as const) {
				for (const token of rule?.[kind] ?? []) {
					if (!roles.has(RoleName(token))) {
						throw new Error(
							`Unknown role "${token}" in ${group} "${name}" ${operation}.${kind}`,
						);
					}
				}
			}
		}
	}
};

const seedPrincipals = (): Map<Principal, RoleManifest> => {
	const principals = new Map<Principal, RoleManifest>();
	for (const name of PrincipalNameSchema.literals) {
		principals.set(PRINCIPAL[name], {
			name: PRINCIPAL[name],
			capabilities: new Set(
				name === "admin" || name === "server" ? ROLE_CAPABILITY : [],
			),
		});
	}
	return principals;
};

const isPrincipalName = Schema.is(PrincipalNameSchema);

const declareRoles = (
	precedent: RoleRegistry,
	named: Readonly<Record<string, RoleArg | undefined>> | undefined,
	overrides: PrincipalsArg | undefined,
): {
	registry: RoleRegistry;
	declared: DeclaredTokens;
} => {
	const roles = new Map(precedent.roles);
	const principals = new Map(precedent.principals);
	const declaredRoles = new Set<RoleName>();
	const declaredPrincipals = new Set<PrincipalName>();

	// Resolve principals
	for (const [key, arg] of Object.entries(overrides ?? {})) {
		if (typeof arg === "undefined" || !isPrincipalName(key)) {
			continue;
		}
		principals.set(PRINCIPAL[key], {
			name: PRINCIPAL[key],
			capabilities: new Set(arg.permission),
		});
		declaredPrincipals.add(key);
	}

	// Resolve roles
	for (const [key, arg] of Object.entries(named ?? {})) {
		if (typeof arg === "undefined") {
			continue;
		}
		if (PRINCIPAL_BY_NAME.has(key)) {
			throw new Error(
				`Role "${key}" is a principal — declare it under "principals"`,
			);
		}
		if (isUndeclarableRole(key)) {
			throw new Error(
				`Role "${key}" cannot be declared: it is granted to a user, never declared by a namespace`,
			);
		}
		const roleName = RoleName(key);
		roles.set(roleName, {
			name: roleName,
			description: arg.description ?? roles.get(roleName)?.description,
			capabilities: new Set(arg.permission),
		});
		declaredRoles.add(roleName);
	}

	return {
		registry: { roles, principals },
		declared: { roles: declaredRoles, principals: declaredPrincipals },
	};
};

export function defineNamespace<
	const Roles extends Record<string, RoleArg> = {},
	Replicant extends Record<string, Schema.Schema<any, any, never>> = {},
	Computed extends Record<string, Schema.Schema<any, any, never>> = {},
	Topic extends Record<string, Schema.Schema<any, any, never>> = {},
	Rpc extends Record<
		string,
		RpcFieldOption<WriteOnlyPermissionArg<keyof Roles & string>>
	> = {},
>(
	namespace: string,
	defineOption: {
		roles?: Roles & { [K in UndeclarableRoleName]?: never };
		principals?: PrincipalsArg;
		replicant?: {
			[K in keyof Replicant & string]: FieldOption<
				Replicant[K],
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
		rpc?: Rpc;
	},
): NamespaceManifest<
	{ [K in keyof Replicant]: Schema.Schema.Type<Replicant[K]> },
	{ [K in keyof Computed]: Schema.Schema.Type<Computed[K]> },
	{ [K in keyof Topic]: Schema.Schema.Type<Topic[K]> },
	AddedRpcDecoded<Rpc>
> {
	const { registry, declared } = declareRoles(
		{ roles: new Map(), principals: seedPrincipals() },
		defineOption.roles,
		defineOption.principals,
	);

	const namedRoles = new Set(registry.roles.keys());

	validatePermissionTokens("replicant", defineOption.replicant, registry.roles);
	validatePermissionTokens("computed", defineOption.computed, registry.roles);
	validatePermissionTokens("topic", defineOption.topic, registry.roles);
	validatePermissionTokens("rpc", defineOption.rpc, registry.roles);

	const resolve = (
		capability: RoleCapability,
		rule: PermissionRuleArg<keyof Roles & string> | undefined,
	) => resolveAccess(registry, declared, capability, undefined, rule);

	const replicant = mapValues<
		FieldOptionLambda<PermissionArg<keyof Roles & string>>,
		FieldManifestFromSchemaLambda
	>((option, name) => ({
		...implementCodec(name, option.schema),
		permission: replicantPermission(
			resolve("replicant-read", option.permission?.read),
			resolve("replicant-write", option.permission?.write),
			namedRoles,
		),
	}))(defineOption.replicant);

	const computed = mapValues<
		FieldOptionLambda<ReadOnlyPermissionArg<keyof Roles & string>>,
		FieldManifestFromSchemaLambda
	>((option, name) => ({
		...implementCodec(name, option.schema),
		permission: computedPermission(
			resolve("computed-read", option.permission?.read),
			namedRoles,
		),
	}))(defineOption.computed);

	const topic = mapValues<
		FieldOptionLambda<PermissionArg<keyof Roles & string>>,
		FieldManifestFromSchemaLambda
	>((option, name) => ({
		...implementCodec(name, option.schema),
		permission: topicPermission(
			resolve("topic-subscribe", option.permission?.read),
			resolve("topic-publish", option.permission?.write),
			namedRoles,
		),
	}))(defineOption.topic);

	const rpc = mapRpcValues<
		RpcFieldOption<WriteOnlyPermissionArg<keyof Roles & string>>,
		RpcFieldManifestFromSchemaLambda
	>()(defineOption.rpc, (option, name) => ({
		name,
		request: makeCodec(name, option.schema.request),
		response: makeCodec(name, option.schema.response),
		permission: rpcPermission(
			resolve("rpc-call", option.permission?.write),
			namedRoles,
		),
	}));

	return {
		namespace,
		replicant: replicant,
		computed,
		topic,
		rpc,
		[manifestRolesKey]: registry,
	};
}

/** extend **/

interface ExtendFieldOption<
	P extends PermissionArg<string> | ReadOnlyPermissionArg<string>,
> {
	readonly schema?: Schema.Schema<any, any, never>;
	readonly permission?: P;
}

interface ExtendRpcFieldOption<P extends WriteOnlyPermissionArg<string>> {
	readonly schema?: RpcSchemaPair;
	readonly permission?: P;
}

type Override<Precedent, Added> = Omit<Precedent, keyof Added> & Added;

type AddedDecoded<In> = {
	readonly [K in keyof AddedSchemas<In>]: Schema.Schema.Type<
		AddedSchemas<In>[K]
	>;
};

type AddedRpcDecoded<In> = {
	readonly [K in keyof AddedRpcSchemas<In>]: {
		readonly request: Schema.Schema.Type<AddedRpcSchemas<In>[K]["request"]>;
		readonly response: Schema.Schema.Type<AddedRpcSchemas<In>[K]["response"]>;
	};
};

export function extendNamespace<
	PReplicant extends Record<string, unknown>,
	PComputed extends Record<string, unknown>,
	PTopic extends Record<string, unknown>,
	PRpc extends Record<
		string,
		{ readonly request: unknown; readonly response: unknown }
	>,
	const EReplicant extends Record<
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
	const ERpc extends Record<
		string,
		ExtendRpcFieldOption<WriteOnlyPermissionArg<string>>
	> = {},
>(
	manifest: NamespaceManifest<PReplicant, PComputed, PTopic, PRpc>,
	extendOptionOrFn:
		| {
				readonly roles?: Record<string, RoleArg>;
				readonly principals?: PrincipalsArg;
				readonly replicant?: EReplicant;
				readonly computed?: EComputed;
				readonly topic?: ETopic;
				readonly rpc?: ERpc;
		  }
		| ((precedent: NamespaceManifest<PReplicant, PComputed, PTopic, PRpc>) => {
				readonly roles?: Record<string, RoleArg>;
				readonly principals?: PrincipalsArg;
				readonly replicant?: EReplicant;
				readonly computed?: EComputed;
				readonly topic?: ETopic;
				readonly rpc?: ERpc;
		  }),
): NamespaceManifest<
	Override<PReplicant, AddedDecoded<EReplicant>>,
	Override<PComputed, AddedDecoded<EComputed>>,
	Override<PTopic, AddedDecoded<ETopic>>,
	Override<PRpc, AddedRpcDecoded<ERpc>>
> {
	const extendOption =
		typeof extendOptionOrFn === "function"
			? extendOptionOrFn(manifest)
			: extendOptionOrFn;

	const { registry, declared } = declareRoles(
		manifest[manifestRolesKey],
		extendOption.roles,
		extendOption.principals,
	);

	const namedRoles = new Set(registry.roles.keys());

	validatePermissionTokens("replicant", extendOption.replicant, registry.roles);
	validatePermissionTokens("computed", extendOption.computed, registry.roles);
	validatePermissionTokens("topic", extendOption.topic, registry.roles);
	validatePermissionTokens("rpc", extendOption.rpc, registry.roles);

	const resolve = (
		capability: RoleCapability,
		rule: PermissionRuleArg<string> | undefined,
	) => resolveAccess(registry, declared, capability, undefined, rule);

	const remap = (
		capability: RoleCapability,
		precedent: Access,
		rule: PermissionRuleArg<string> | undefined,
	) => resolveAccess(registry, declared, capability, precedent, rule);

	const replicantRemap = mapValues<FieldManifestLambda, FieldManifestLambda>(
		(field, name) => {
			const override = extendOption.replicant?.[name];
			return {
				name: field.name,
				decode: field.decode,
				encode: field.encode,
				permission: replicantPermission(
					remap(
						"replicant-read",
						field.permission.read,
						override?.permission?.read,
					),
					remap(
						"replicant-write",
						field.permission.write,
						override?.permission?.write,
					),
					namedRoles,
				),
			};
		},
	)(manifest.replicant);

	const replicantAdded = mapSchemaValues<
		ExtendFieldOption<PermissionArg<string>>,
		FieldManifestLambda
	>()(extendOption.replicant, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: replicantPermission(
			resolve("replicant-read", option.permission?.read),
			resolve("replicant-write", option.permission?.write),
			namedRoles,
		),
	}));
	const replicant = mergeRecords<
		NamespaceManifest<
			Override<PReplicant, AddedDecoded<EReplicant>>,
			PComputed,
			PTopic
		>["replicant"]
	>(replicantRemap, replicantAdded);

	const computedRemap = mapValues<FieldManifestLambda, FieldManifestLambda>(
		(field, name) => {
			const override = extendOption.computed?.[name];
			return {
				name: field.name,
				decode: field.decode,
				encode: field.encode,
				permission: computedPermission(
					remap(
						"computed-read",
						field.permission.read,
						override?.permission?.read,
					),
					namedRoles,
				),
			};
		},
	)(manifest.computed);
	const computedAdded = mapSchemaValues<
		ExtendFieldOption<ReadOnlyPermissionArg<string>>,
		FieldManifestLambda
	>()(extendOption.computed, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: computedPermission(
			resolve("computed-read", option.permission?.read),
			namedRoles,
		),
	}));
	const computed = mergeRecords<
		NamespaceManifest<
			PReplicant,
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
				permission: topicPermission(
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
					namedRoles,
				),
			};
		},
	)(manifest.topic);
	const topicAdded = mapSchemaValues<
		ExtendFieldOption<PermissionArg<string>>,
		FieldManifestLambda
	>()(extendOption.topic, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: topicPermission(
			resolve("topic-subscribe", option.permission?.read),
			resolve("topic-publish", option.permission?.write),
			namedRoles,
		),
	}));
	const topic = mergeRecords<
		NamespaceManifest<
			PReplicant,
			PComputed,
			Override<PTopic, AddedDecoded<ETopic>>
		>["topic"]
	>(topicRemap, topicAdded);

	const rpcRemap = mapValues<RpcFieldManifestLambda, RpcFieldManifestLambda>(
		(field, name) => {
			const override = extendOption.rpc?.[name];
			return {
				name: field.name,
				request: field.request,
				response: field.response,
				permission: rpcPermission(
					remap(
						"rpc-call",
						field.permission.write,
						override?.permission?.write,
					),
					namedRoles,
				),
			};
		},
	)(manifest.rpc);
	const rpcAdded = mapRpcValues<
		ExtendRpcFieldOption<WriteOnlyPermissionArg<string>>,
		RpcFieldManifestFromSchemaLambda
	>()(extendOption.rpc, (option, name) => ({
		name,
		request: makeCodec(name, option.schema.request),
		response: makeCodec(name, option.schema.response),
		permission: rpcPermission(
			resolve("rpc-call", option.permission?.write),
			namedRoles,
		),
	}));
	const rpc = mergeRecords<
		NamespaceManifest<
			PReplicant,
			PComputed,
			PTopic,
			Override<PRpc, AddedRpcDecoded<ERpc>>
		>["rpc"]
	>(rpcRemap, rpcAdded);

	return {
		namespace: manifest.namespace,
		[manifestRolesKey]: registry,
		replicant: replicant,
		computed,
		topic,
		rpc,
	};
}
