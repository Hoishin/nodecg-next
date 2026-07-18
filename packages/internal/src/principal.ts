import { Brand, Schema } from "effect";

export type Principal = string & Brand.Brand<"Principal">;
export const Principal = Brand.nominal<Principal>();

export const DeclarablePrincipalNameSchema = Schema.Literal(
	"everyone",
	"client",
);

export const UndeniablePrincipalNameSchema = Schema.Literal("server", "admin");

export const PrincipalNameSchema = Schema.Literal(
	...DeclarablePrincipalNameSchema.literals,
	...UndeniablePrincipalNameSchema.literals,
);

export const PRINCIPAL: Record<typeof PrincipalNameSchema.Type, Principal> = {
	// Unauthenticated users and users with no role
	everyone: Principal("everyone"),
	// Every named role a namespace declares
	client: Principal("client"),
	// Exclusive to server-side calls
	server: Principal("server"),
	// Holds every capability
	admin: Principal("admin"),
} as const;

export type PrincipalName = typeof PrincipalNameSchema.Type;
export type DeclarablePrincipalName = typeof DeclarablePrincipalNameSchema.Type;
