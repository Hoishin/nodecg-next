import { Config, Duration } from "effect";

export const config = {
	origin: Config.string("ORIGIN").pipe(
		Config.withDefault("http://localhost:3000"),
	),
	requireAuth: Config.boolean("REQUIRE_AUTH").pipe(Config.withDefault(false)),
	sessionTtl: Config.duration("SESSION_TTL").pipe(
		Config.withDefault(Duration.decode("7 days")),
	),
};
