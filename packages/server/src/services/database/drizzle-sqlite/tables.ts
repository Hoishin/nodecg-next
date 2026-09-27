import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const loginAttempts = sqliteTable("login_attempts", {
	key: text("key").primaryKey(),
	provider: text("provider").notNull(),
	state: text("state").notNull(),
	codeVerifier: text("code_verifier"),
	nonce: text("nonce"),
	returnTo: text("return_to"),
	expiresAt: integer("expires_at").notNull(),
});
