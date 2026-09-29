import { Layer } from "effect";

import { DrizzleSqliteDatabaseService } from "../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import { DrizzleSqliteTransaction } from "../transaction/drizzle-sqlite-transaction.ts";
import { DrizzleSqliteAccountRepository } from "./account/drizzle-sqlite-account-repository.ts";
import { DrizzleSqliteAuthenticationRepository } from "./authentication/drizzle-sqlite-authentication-repository.ts";
import { DrizzleSqliteLoginAttemptRepository } from "./login-attempt/drizzle-sqlite-login-attempt-repository.ts";
import { DrizzleSqliteSessionRepository } from "./session/drizzle-sqlite-session-repository.ts";

export const DrizzleSqliteRepositories = Layer.mergeAll(
	DrizzleSqliteLoginAttemptRepository,
	DrizzleSqliteAuthenticationRepository,
	DrizzleSqliteSessionRepository,
	DrizzleSqliteAccountRepository,
	DrizzleSqliteTransaction,
).pipe(Layer.provide(DrizzleSqliteDatabaseService.layer));
