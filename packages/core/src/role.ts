import {
	RESERVED_ROLE,
	RoleName,
	type Identity,
	type UsableReservedRoleName,
} from "@nodecg/internal";
import { Match } from "effect";

export type RoleCapability =
	| "state-read"
	| "state-write"
	| "computed-read"
	| "topic-subscribe"
	| "topic-publish"
	| "rpc-call";

export interface RoleArg {
	readonly description?: string;
	readonly permission: ReadonlyArray<RoleCapability>;
}

export interface PermissionRuleArg<InputRole extends string> {
	readonly allow?: readonly (InputRole | UsableReservedRoleName)[];
	readonly deny?: readonly (InputRole | UsableReservedRoleName)[];
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
	readonly name: RoleName;
	readonly description?: string;
	readonly capabilities: ReadonlySet<RoleCapability>;
}
export interface ResolvedPermission {
	readonly read: ReadonlySet<RoleName>;
	readonly write: ReadonlySet<RoleName>;
	readonly canRead: (caller: Identity) => boolean;
	readonly canWrite: (caller: Identity) => boolean;
}

const getRolesFromIdentity = (caller: Identity) =>
	Match.value(caller).pipe(
		Match.withReturnType<ReadonlySet<RoleName>>(),
		Match.tag("human", (human) => human.roles),
		Match.tag("machine", () => new Set()), // TODO: resolve once machine account has roles
		Match.tag("public", () => new Set()),
		Match.tag("server", () => new Set([RESERVED_ROLE.server])),
		Match.exhaustive,
	);

export const isAdminTier = (caller: Identity): boolean => {
	const roles = getRolesFromIdentity(caller);
	return roles.has(RESERVED_ROLE.superadmin) || roles.has(RESERVED_ROLE.admin);
};

const isAllowed = (
	resolved: ReadonlySet<RoleName>,
	caller: ReadonlySet<RoleName>,
): boolean =>
	caller.has(RESERVED_ROLE.superadmin) ||
	caller.has(RESERVED_ROLE.admin) ||
	resolved.has(RESERVED_ROLE.public) ||
	[...caller].some((role) => resolved.has(role));

export const buildPermission = (
	read: ReadonlySet<RoleName>,
	write: ReadonlySet<RoleName>,
	writable: boolean,
) => ({
	read,
	write,
	canRead: (caller: Identity): boolean =>
		isAllowed(read, getRolesFromIdentity(caller)),
	canWrite: writable
		? (caller: Identity): boolean =>
				isAllowed(write, getRolesFromIdentity(caller))
		: (): boolean => false,
});
