import { Config, Duration, Redacted, Schema } from "effect";

const SuperadminEntrySchema = Schema.TemplateLiteralParser(
	Schema.Trim.pipe(Schema.compose(Schema.NonEmptyString)),
	":",
	Schema.Trim.pipe(Schema.compose(Schema.NonEmptyString)),
).pipe(
	Schema.transform(
		Schema.Struct({
			provider: Schema.NonEmptyTrimmedString,
			subject: Schema.NonEmptyTrimmedString,
		}),
		{
			strict: true,
			decode: ([provider, , subject]) => ({ provider, subject }),
			encode: ({ provider, subject }) => [provider, ":", subject] as const,
		},
	),
);

const SuperadminsSchema = Schema.split(",").pipe(
	Schema.compose(Schema.Array(SuperadminEntrySchema)),
);

export const config = {
	origin: Config.string("ORIGIN").pipe(
		Config.withDefault("http://localhost:3000"),
	),
	requireAuth: Config.boolean("REQUIRE_AUTH").pipe(Config.withDefault(false)),
	sessionTtl: Config.duration("SESSION_TTL").pipe(
		Config.withDefault(Duration.decode("7 days")),
	),
	superadminClaimToken: Config.option(
		Config.redacted("SUPERADMIN_CLAIM_TOKEN").pipe(
			Config.validate({
				message: "SUPERADMIN_CLAIM_TOKEN must be at least 16 characters",
				validation: (token) => Redacted.value(token).length >= 16,
			}),
		),
	),
	superadmins: Config.option(Schema.Config("SUPERADMINS", SuperadminsSchema)),
};
