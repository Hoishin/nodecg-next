import { Effect } from "effect";

// TODO: support automatic migrations
export const migrationDie = Effect.orDieWith(
	() =>
		"Currently stored replicant value failed schema validation. Migration is not supported yet.",
);
