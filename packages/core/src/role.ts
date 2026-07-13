import {
	ADMIN_ROLE,
	PRINCIPAL,
	type Identity,
	type Principal,
	type PrincipalName,
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

export interface PrincipalArg {
	readonly permission: ReadonlyArray<RoleCapability>;
}

export interface RoleArg {
	readonly description?: string;
	readonly permission: ReadonlyArray<RoleCapability>;
}

export type PrincipalsArg = {
	readonly [K in PrincipalName]?: PrincipalArg;
};

export interface PermissionRuleArg<InputRole extends string> {
	readonly allow?: readonly (InputRole | PrincipalName)[];
	readonly deny?: readonly (InputRole | PrincipalName)[];
}
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
export interface ResolvedPermission {
	readonly read: ReadonlySet<RoleName | Principal>;
	readonly write: ReadonlySet<RoleName | Principal>;
	readonly canRead: (caller: Identity) => boolean;
	readonly canWrite: (caller: Identity) => boolean;
}

const getRoles = (caller: Identity): ReadonlySet<RoleName> =>
	Match.value(caller).pipe(
		Match.withReturnType<ReadonlySet<RoleName>>(),
		Match.tag("human", (human) => human.roles),
		Match.tag("machine", (machine) => machine.roles),
		Match.tag("anonymous", () => new Set()),
		Match.tag("server", () => new Set()),
		Match.exhaustive,
	);

const ADMIN_ROLES = new Set(Object.values(ADMIN_ROLE));

const getPrincipals = (caller: Identity): ReadonlySet<Principal> => {
	const principals = new Set([PRINCIPAL.everyone]);
	if (caller._tag === "server") {
		principals.add(PRINCIPAL.server);
	}
	if (!getRoles(caller).isDisjointFrom(ADMIN_ROLES)) {
		principals.add(PRINCIPAL.admin);
	}
	return principals;
};

export const isAdminTier = (caller: Identity): boolean =>
	getPrincipals(caller).has(PRINCIPAL.admin);

const isAllowed = (
	resolved: ReadonlySet<RoleName | Principal>,
	caller: Identity,
): boolean =>
	!getRoles(caller).isDisjointFrom(resolved) ||
	!getPrincipals(caller).isDisjointFrom(resolved);

export const buildPermission = (
	read: ReadonlySet<RoleName | Principal>,
	write: ReadonlySet<RoleName | Principal>,
	writable: boolean,
) => ({
	read,
	write,
	canRead: (caller: Identity): boolean => isAllowed(read, caller),
	canWrite: writable
		? (caller: Identity): boolean => isAllowed(write, caller)
		: (): boolean => false,
});
