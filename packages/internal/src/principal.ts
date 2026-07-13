import { Brand, Schema } from "effect";

export type Principal = string & Brand.Brand<"Principal">;
export const Principal = Brand.nominal<Principal>();

export const PrincipalNameSchema = Schema.Literal(
	"everyone",
	"client",
	"server",
	"admin",
);

export const PRINCIPAL: Record<typeof PrincipalNameSchema.Type, Principal> = {
	// Unauthenticated users and users with no role
	everyone: Principal("everyone"),
	// Every named role a namespace declares
	client: Principal("client"),
	// Exclusive to server-side calls
	server: Principal("server"),
	// Holds every capability by default
	admin: Principal("admin"),
} as const;

export type PrincipalName = typeof PrincipalNameSchema.Type;

export const PRINCIPAL_BY_NAME = new Map(Object.entries(PRINCIPAL));
