import { bigint, pgTable, text } from "drizzle-orm/pg-core";

export const loginAttempts = pgTable("login_attempts", {
	key: text("key").primaryKey(),
	provider: text("provider").notNull(),
	state: text("state").notNull(),
	codeVerifier: text("code_verifier"),
	nonce: text("nonce"),
	returnTo: text("return_to"),
	expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});
