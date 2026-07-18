export {
	declaredRoleNames,
	defineNamespace,
	extendNamespace,
	FieldDecodeError,
	FieldEncodeError,
	type FieldCodec,
	type FieldManifest,
	type RpcFieldManifest,
	type NamespaceManifest,
} from "./define-namespace.ts";
export {
	getRolesFromIdentity,
	isAdminTier,
	isSuperadmin,
	type Access,
	type Grant,
	type RoleArg,
	type RoleCapability,
	type ResolvedPermission,
} from "./role.ts";
