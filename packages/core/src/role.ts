import {
	ADMIN_ROLE,
	DeclarablePrincipalNameSchema,
	type DeclarablePrincipalName,
	type Identity,
	type Principal,
	type RoleName,
} from "@nodecg/internal";
import { Match } from "effect";

export const ROLE_CAPABILITY = [
	"replicant-read",
	"replicant-write",
	"computed-read",
	"topic-subscribe",
	"topic-publish",
	"rpc-call",
] as const;

export type RoleCapability = (typeof ROLE_CAPABILITY)[number];

export type Grant = "allow" | "deny";

export interface PrincipalArg {
	readonly permission: ReadonlyArray<RoleCapability>;
}

export interface RoleArg {
	readonly description?: string;
	readonly permission: ReadonlyArray<RoleCapability>;
}

export type PrincipalsArg = {
	readonly [K in DeclarablePrincipalName]?: PrincipalArg;
};

export type PrincipalGrants = {
	readonly [K in DeclarablePrincipalName]?: Grant;
};

export type PermissionRuleArg<InputRole extends string> = PrincipalGrants & {
	readonly allow?: readonly InputRole[];
	readonly deny?: readonly InputRole[];
};
export interface PermissionArg<InputRole extends string> {
	readonly read?: PermissionRuleArg<InputRole>;
	readonly write?: PermissionRuleArg<InputRole>;
}
export interface ReadOnlyPermissionArg<InputRole extends string> {
	readonly read?: PermissionRuleArg<InputRole>;
}
export interface WriteOnlyPermissionArg<InputRole extends string> {
	readonly write?: PermissionRuleArg<InputRole>;
}

export interface RoleManifest {
	readonly name: RoleName | Principal;
	readonly description?: string;
	readonly capabilities: ReadonlySet<RoleCapability>;
}

export type Access = PrincipalGrants & {
	readonly roles: ReadonlySet<RoleName>;
	readonly rolesDenied: ReadonlySet<RoleName>;
};

export interface ResolvedPermission {
	readonly read: Access;
	readonly write: Access;
	readonly canRead: (caller: Identity) => boolean;
	readonly canWrite: (caller: Identity) => boolean;
}

export const getRolesFromIdentity = (caller: Identity): ReadonlySet<RoleName> =>
	Match.value(caller).pipe(
		Match.withReturnType<ReadonlySet<RoleName>>(),
		Match.tag("human", (human) => human.roles),
		Match.tag("machine", (machine) => machine.roles),
		Match.tag("anonymous", () => new Set()),
		Match.tag("server", () => new Set()),
		Match.exhaustive,
	);

const ADMIN_ROLES = new Set(Object.values(ADMIN_ROLE));

export const isAdminTier = (caller: Identity): boolean =>
	!getRolesFromIdentity(caller).isDisjointFrom(ADMIN_ROLES);

export const isSuperadmin = (caller: Identity): boolean =>
	getRolesFromIdentity(caller).has(ADMIN_ROLE.superadmin);

const can = (
	access: Access,
	caller: Identity,
	namedRoles: ReadonlySet<RoleName>,
): boolean => {
	if (caller._tag === "server") {
		return true;
	}
	const roles = getRolesFromIdentity(caller);
	if (!roles.isDisjointFrom(ADMIN_ROLES)) {
		return true;
	}

	const isClient = !roles.isDisjointFrom(namedRoles);
	if (isClient && access.client === "deny") {
		return false;
	}

	if (access.everyone === "deny") {
		return false;
	}
	if (!roles.isDisjointFrom(access.rolesDenied)) {
		return false;
	}

	return (
		(isClient && access.client === "allow") ||
		access.everyone === "allow" ||
		!roles.isDisjointFrom(access.roles)
	);
};

const EMPTY_ACCESS: Access = {
	roles: new Set(),
	rolesDenied: new Set(),
};

const buildPermission = (
	read: Access,
	write: Access,
	namedRoles: ReadonlySet<RoleName>,
): ResolvedPermission => ({
	read,
	write,
	canRead: (caller: Identity): boolean => can(read, caller, namedRoles),
	canWrite: (caller: Identity): boolean => can(write, caller, namedRoles),
});

const canReadWhenCanWrite = (
	read: Grant | undefined,
	write: Grant | undefined,
): Grant | undefined =>
	read === "deny" ? "deny" : write === "allow" ? "allow" : read;

const cantWriteWhenCantRead = (
	read: Grant | undefined,
	write: Grant | undefined,
): Grant | undefined => (read === "deny" ? "deny" : write);

const foldSlots = (
	fold: (
		read: Grant | undefined,
		write: Grant | undefined,
	) => Grant | undefined,
	read: Access,
	write: Access,
): PrincipalGrants => {
	const slots: { [K in DeclarablePrincipalName]?: Grant } = {};
	for (const name of DeclarablePrincipalNameSchema.literals) {
		slots[name] = fold(read[name], write[name]);
	}
	return slots;
};

export const replicantPermission = (
	read: Access,
	write: Access,
	namedRoles: ReadonlySet<RoleName>,
): ResolvedPermission => {
	const writeDenied = write.rolesDenied.union(read.rolesDenied);
	return buildPermission(
		{
			roles: read.roles.union(write.roles).difference(read.rolesDenied),
			rolesDenied: read.rolesDenied,
			...foldSlots(canReadWhenCanWrite, read, write),
		},
		{
			roles: write.roles.difference(writeDenied),
			rolesDenied: writeDenied,
			...foldSlots(cantWriteWhenCantRead, read, write),
		},
		namedRoles,
	);
};

const absentOperation = () => false;

export const computedPermission = (
	read: Access,
	namedRoles: ReadonlySet<RoleName>,
): ResolvedPermission => ({
	read,
	write: EMPTY_ACCESS,
	canRead: (caller: Identity): boolean => can(read, caller, namedRoles),
	canWrite: absentOperation,
});

export const rpcPermission = (
	call: Access,
	namedRoles: ReadonlySet<RoleName>,
): ResolvedPermission => ({
	read: EMPTY_ACCESS,
	write: call,
	canRead: absentOperation,
	canWrite: (caller: Identity): boolean => can(call, caller, namedRoles),
});

export const topicPermission = (
	subscribe: Access,
	publish: Access,
	namedRoles: ReadonlySet<RoleName>,
): ResolvedPermission => buildPermission(subscribe, publish, namedRoles);
