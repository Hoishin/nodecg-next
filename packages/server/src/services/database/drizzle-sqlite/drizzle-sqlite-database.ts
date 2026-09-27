import { SqliteClient } from "@effect/sql-sqlite-node";
import * as SQLiteNodeDrizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import {
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Path,
	Schema,
} from "effect";

import { resolveDataDir } from "../../../data-dir.ts";
import { findPackageRoot } from "../../../package-root.ts";
import { BackendError } from "../../repository/repository-errors.ts";

export class MigrationsNotFound extends Schema.TaggedError<MigrationsNotFound>()(
	"MigrationsNotFound",
	{ from: Schema.String },
) {
	override readonly message = `No package.json at or above ${this.from}, so the SQLite migrations cannot be located`;
}

const SQLITE_DATABASE_FILENAME = "nodecg.sqlite3";

const systemDatabaseFile = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const path = yield* Path.Path;
	const dataDir = yield* resolveDataDir();
	yield* fs.makeDirectory(dataDir, { recursive: true });
	const file = path.join(dataDir, SQLITE_DATABASE_FILENAME);
	yield* Effect.logInfo(`Storing system data in ${file}`);
	return file;
}).pipe(
	Effect.catchTag("PlatformError", (cause) => BackendError.make({ cause })),
);

export class DrizzleSqliteDatabaseService extends Context.Service<DrizzleSqliteDatabaseService>()(
	"DrizzleSqliteDatabase",
	{
		make: Effect.fn("DrizzleSqliteDatabase.make")(
			function* (filename: string) {
				const path = yield* Path.Path;
				const client = yield* SqliteClient.make({ filename });
				const db = yield* SQLiteNodeDrizzle.makeWithDefaults().pipe(
					Effect.provideService(SqliteClient.SqliteClient, client),
				);
				const moduleDirectory = yield* path.fromFileUrl(
					new URL(".", import.meta.url),
				);
				const packageRoot = yield* findPackageRoot(moduleDirectory);
				if (Option.isNone(packageRoot)) {
					return yield* MigrationsNotFound.make({ from: moduleDirectory });
				}
				yield* migrate(db, {
					migrationsFolder: path.join(
						packageRoot.value,
						"migrations",
						"drizzle-sqlite",
					),
				});
				return db;
			},
			Effect.catchTag(
				[
					"BadArgument",
					"PlatformError",
					"MigratorInitError",
					"EffectDrizzleQueryError",
					"SqlError",
				],
				(cause) => BackendError.make({ cause }),
			),
		),
	},
) {
	static readonly layer = Layer.effect(
		this,
		systemDatabaseFile.pipe(Effect.flatMap(this.make)),
	);
}
