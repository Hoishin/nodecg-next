import type { Authentication } from "@nodecg-next/internal";
import { and, eq } from "drizzle-orm";
import { Array, Effect, Layer, Option } from "effect";

import { DrizzleSqliteDatabaseService } from "../../database/drizzle-sqlite/drizzle-sqlite-database.ts";
import {
	authentications,
	users,
} from "../../database/drizzle-sqlite/tables.ts";
import { BackendError } from "../repository-errors.ts";
import { AccountRepositoryService } from "./account-repository.ts";

export const DrizzleSqliteAccountRepository = Layer.effect(
	AccountRepositoryService,
	Effect.gen(function* () {
		const db = yield* DrizzleSqliteDatabaseService;

		const resolveByAuthentication = Effect.fn(
			"AccountRepository.resolveByAuthentication",
		)(
			function* ({ issuer, subject }: Authentication) {
				const rows = yield* db
					.select({ accountId: users.accountId })
					.from(authentications)
					.innerJoin(users, eq(authentications.userId, users.id))
					.where(
						and(
							eq(authentications.issuer, issuer),
							eq(authentications.subject, subject),
						),
					);
				return Array.head(rows).pipe(Option.map(({ accountId }) => accountId));
			},
			Effect.catchTag("EffectDrizzleQueryError", (cause) =>
				BackendError.make({ cause }),
			),
		);

		return { resolveByAuthentication };
	}),
);
