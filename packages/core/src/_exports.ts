export {
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
	isAdminTier,
	isSuperadmin,
	type Access,
	type Grant,
	type RoleArg,
	type RoleCapability,
	type ResolvedPermission,
} from "./role.ts";
