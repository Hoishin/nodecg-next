import { Config, Duration } from "effect";

export const requireAuth = Config.boolean("REQUIRE_AUTH").pipe(
	Config.withDefault(false),
);

export const publicOrigin = Config.string("PUBLIC_ORIGIN").pipe(
	Config.withDefault("http://localhost:3000"),
);

export const sessionTtl = Config.duration("SESSION_TTL").pipe(
	Config.withDefault(Duration.decode("7 days")),
);
