import {
	isUndeclarableRole,
	PRINCIPAL,
	Principal,
	PRINCIPAL_BY_NAME,
	RoleName,
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
	buildPermission,
	ROLE_CAPABILITY,
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

const brandToken = (token: string): RoleName | Principal =>
	PRINCIPAL_BY_NAME.get(token) ?? RoleName(token);

const expandClientRoles = (
	tokens: ReadonlyArray<RoleName | Principal>,
	namedRoles: ReadonlySet<RoleName>,
): Set<RoleName | Principal> => {
	const result = new Set<RoleName | Principal>();
	for (const token of tokens) {
		if (token === PRINCIPAL.client) {
			for (const named of namedRoles) {
				result.add(named);
			}
		} else {
			result.add(token);
		}
	}
	return result;
};

const resolveFieldAllowedRoles = (
	base: ReadonlySet<RoleName | Principal>,
	rule: PermissionRuleArg<string> | undefined,
	namedRoles: ReadonlySet<RoleName>,
): ReadonlySet<RoleName | Principal> => {
	let result = new Set(base);
	if (rule?.allow) {
		// Allow field overrides entire list, except admin who is always allowed
		result = expandClientRoles(rule.allow.map(brandToken), namedRoles);
		if (base.has(PRINCIPAL.admin)) {
			result.add(PRINCIPAL.admin);
		}
	}
	if (rule?.deny) {
		// Deny field then subtracts roles
		result = result.difference(
			expandClientRoles(rule.deny.map(brandToken), namedRoles),
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
	group: "replicant" | "computed" | "topic" | "rpc",
	fields: Readonly<Record<string, FieldPermissionOptions>> | undefined,
	tokens: ReadonlySet<RoleName | Principal>,
): void => {
	for (const [name, field] of Object.entries(fields ?? {})) {
		for (const operation of ["read", "write"] as const) {
			const rule = field.permission?.[operation];
			for (const kind of ["allow", "deny"] as const) {
				for (const token of rule?.[kind] ?? []) {
					if (!tokens.has(brandToken(token))) {
						throw new Error(
							`Unknown role "${token}" in ${group} "${name}" ${operation}.${kind}`,
						);
					}
				}
			}
		}
	}
};

const collectPermissionTokens = (
	registry: RoleRegistry,
): ReadonlySet<RoleName | Principal> =>
	new Set([...registry.roles.keys(), ...registry.principals.keys()]);

const seedPrincipals = (): Map<Principal, RoleManifest> => {
	const principals = new Map<Principal, RoleManifest>();
	for (const principal of Object.values(PRINCIPAL)) {
		principals.set(principal, {
			name: principal,
			capabilities: new Set(
				principal === PRINCIPAL.admin ? ROLE_CAPABILITY : [],
			),
		});
	}
	return principals;
};

const declareRoles = (
	precedent: RoleRegistry,
	named: Readonly<Record<string, RoleArg | undefined>> | undefined,
	overrides: PrincipalsArg | undefined,
): {
	registry: RoleRegistry;
	declared: {
		roles: ReadonlySet<RoleName>;
		principals: ReadonlySet<Principal>;
	};
} => {
	const roles = new Map(precedent.roles);
	const principals = new Map(precedent.principals);
	const declaredRoles = new Set<RoleName>();
	const declaredPrincipals = new Set<Principal>();

	// Resolve principals
	for (const [key, arg] of Object.entries(overrides ?? {})) {
		if (typeof arg === "undefined") {
			continue;
		}
		const principal = PRINCIPAL_BY_NAME.get(key);
		if (typeof principal === "undefined") {
			continue;
		}
		principals.set(principal, {
			name: principal,
			capabilities: new Set(arg.permission),
		});
		declaredPrincipals.add(principal);
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

const capabilityBase = (
	capability: RoleCapability,
	registry: RoleRegistry,
	namedRoles: ReadonlySet<RoleName>,
): ReadonlySet<RoleName | Principal> => {
	const holders: (RoleName | Principal)[] = [];
	for (const [role, manifest] of registry.roles) {
		if (manifest.capabilities.has(capability)) {
			holders.push(role);
		}
	}
	for (const [principal, manifest] of registry.principals) {
		if (manifest.capabilities.has(capability)) {
			holders.push(principal);
		}
	}
	return expandClientRoles(holders, namedRoles);
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
	const { registry } = declareRoles(
		{ roles: new Map(), principals: seedPrincipals() },
		defineOption.roles,
		defineOption.principals,
	);

	const namedRoles = new Set(registry.roles.keys());
	const tokens = collectPermissionTokens(registry);

	validatePermissionTokens("replicant", defineOption.replicant, tokens);
	validatePermissionTokens("computed", defineOption.computed, tokens);
	validatePermissionTokens("topic", defineOption.topic, tokens);
	validatePermissionTokens("rpc", defineOption.rpc, tokens);

	const resolve = (
		capability: RoleCapability,
		rule: PermissionRuleArg<keyof Roles & string> | undefined,
	) =>
		resolveFieldAllowedRoles(
			capabilityBase(capability, registry, namedRoles),
			rule,
			namedRoles,
		);

	const replicant = mapValues<
		FieldOptionLambda<PermissionArg<keyof Roles & string>>,
		FieldManifestFromSchemaLambda
	>((option, name) => ({
		...implementCodec(name, option.schema),
		permission: buildPermission(
			resolve("replicant-read", option.permission?.read),
			resolve("replicant-write", option.permission?.write),
			true,
		),
	}))(defineOption.replicant);

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

	const rpc = mapRpcValues<
		RpcFieldOption<WriteOnlyPermissionArg<keyof Roles & string>>,
		RpcFieldManifestFromSchemaLambda
	>()(defineOption.rpc, (option, name) => ({
		name,
		request: makeCodec(name, option.schema.request),
		response: makeCodec(name, option.schema.response),
		permission: buildPermission(
			new Set(),
			resolve("rpc-call", option.permission?.write),
			true,
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

	const affected = new Set<RoleName | Principal>([
		...(declared.principals.has(PRINCIPAL.client)
			? namedRoles
			: declared.roles),
		...declared.principals,
	]);

	const tokens = collectPermissionTokens(registry);

	validatePermissionTokens("replicant", extendOption.replicant, tokens);
	validatePermissionTokens("computed", extendOption.computed, tokens);
	validatePermissionTokens("topic", extendOption.topic, tokens);
	validatePermissionTokens("rpc", extendOption.rpc, tokens);

	const resolve = (
		capability: RoleCapability,
		rule: PermissionRuleArg<string> | undefined,
	) =>
		resolveFieldAllowedRoles(
			capabilityBase(capability, registry, namedRoles),
			rule,
			namedRoles,
		);

	const remap = (
		capability: RoleCapability,
		current: ReadonlySet<RoleName | Principal>,
		rule: PermissionRuleArg<string> | undefined,
	) => {
		const base = capabilityBase(capability, registry, namedRoles);
		const result = new Set(current);
		for (const role of affected) {
			if (base.has(role)) {
				result.add(role);
			} else {
				result.delete(role);
			}
		}
		return resolveFieldAllowedRoles(result, rule, namedRoles);
	};

	const replicantRemap = mapValues<FieldManifestLambda, FieldManifestLambda>(
		(field, name) => {
			const override = extendOption.replicant?.[name];
			return {
				name: field.name,
				decode: field.decode,
				encode: field.encode,
				permission: buildPermission(
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
					true,
				),
			};
		},
	)(manifest.replicant);

	const replicantAdded = mapSchemaValues<
		ExtendFieldOption<PermissionArg<string>>,
		FieldManifestLambda
	>()(extendOption.replicant, (option, name) => ({
		...implementCodec(name, option.schema),
		permission: buildPermission(
			resolve("replicant-read", option.permission?.read),
			resolve("replicant-write", option.permission?.write),
			true,
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
				permission: buildPermission(
					new Set(),
					remap(
						"rpc-call",
						field.permission.write,
						override?.permission?.write,
					),
					true,
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
		permission: buildPermission(
			new Set(),
			resolve("rpc-call", option.permission?.write),
			true,
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
