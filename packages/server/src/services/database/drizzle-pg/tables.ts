import type {
	AccountId,
	AuthenticationId,
	UserId,
	UserSessionId,
} from "@nodecg-next/internal";
import { bigint, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";

export const loginAttempts = pgTable("login_attempts", {
	key: text("key").primaryKey(),
	provider: text("provider").notNull(),
	state: text("state").notNull(),
	codeVerifier: text("code_verifier"),
	nonce: text("nonce"),
	returnTo: text("return_to"),
	expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

export const accounts = pgTable("accounts", {
	id: uuid("id").$type<AccountId>().primaryKey().defaultRandom(),
	displayName: text("display_name").notNull(),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const users = pgTable("users", {
	id: uuid("id").$type<UserId>().primaryKey().defaultRandom(),
	accountId: uuid("account_id")
		.$type<AccountId>()
		.notNull()
		.unique()
		.references(() => accounts.id, { onDelete: "cascade" }),
});

export const authentications = pgTable(
	"authentications",
	{
		id: uuid("id").$type<AuthenticationId>().primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.$type<UserId>()
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		issuer: text("issuer").notNull(),
		subject: text("subject").notNull(),
	},
	(table) => [unique().on(table.issuer, table.subject)],
);

export const sessions = pgTable("sessions", {
	id: text("id").$type<UserSessionId>().primaryKey(),
	authenticationId: uuid("authentication_id")
		.$type<AuthenticationId>()
		.notNull()
		.references(() => authentications.id, { onDelete: "cascade" }),
	expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});
