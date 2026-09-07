import { Config, Duration, Option, Schema, SchemaGetter } from "effect";

const NonEmptyTrimmedString = Schema.String.check(
	Schema.isNonEmpty(),
	Schema.isTrimmed(),
);

const SuperadminEntrySchema = Schema.TemplateLiteralParser([
	Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString)),
	":",
	Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString)),
]).pipe(
	Schema.decodeTo(
		Schema.Struct({
			provider: NonEmptyTrimmedString,
			subject: NonEmptyTrimmedString,
		}),
		{
			decode: SchemaGetter.transform(([provider, _colon, subject]) => ({
				provider,
				subject,
			})),
			encode: SchemaGetter.forbidden(() => "decodeOnly"),
		},
	),
);

const SuperadminsSchema = Schema.String.pipe(
	Schema.decodeTo(Schema.Array(Schema.String), {
		decode: SchemaGetter.split({ separator: "," }),
		encode: SchemaGetter.forbidden(() => "decodeOnly"),
	}),
	Schema.decodeTo(Schema.Array(SuperadminEntrySchema)),
);

const port = Config.int("PORT").pipe(Config.withDefault(3000));

const Pathname = Schema.String.pipe(
	Schema.decode({
		decode: SchemaGetter.transform((path) =>
			path === "/" ? "/" : path.replace(/\/+$/, ""),
		),
		encode: SchemaGetter.forbidden(() => "decodeOnly"),
	}),
	Schema.decodeTo(Schema.TemplateLiteral(["/", Schema.String])),
);

const BaseUrlSchema = Schema.URLFromString.pipe(
	Schema.decodeTo(Schema.Struct({ href: Schema.String, pathname: Pathname }), {
		decode: SchemaGetter.transform((url) => ({
			href: url.href,
			pathname: url.pathname,
		})),
		encode: SchemaGetter.forbidden(() => "decodeOnly"),
	}),
);

const baseUrl = Config.all([
	port,
	Config.option(Config.schema(BaseUrlSchema, "NODECG_BASE_URL")),
]).pipe(
	Config.map(([port, baseUrl]) =>
		baseUrl.pipe(
			Option.getOrElse<typeof BaseUrlSchema.Type>(() => ({
				href: `http://localhost:${port}`,
				pathname: "/",
			})),
		),
	),
);

export const config = {
	port,
	baseUrl,
	requireAuth: Config.boolean("REQUIRE_AUTH").pipe(Config.withDefault(false)),
	sessionTtl: Config.duration("SESSION_TTL").pipe(
		Config.withDefault(Duration.days(7)),
	),
	superadminClaimToken: Config.option(
		Config.schema(
			Schema.RedactedFromValue(Schema.String.check(Schema.isMinLength(16))),
			"SUPERADMIN_CLAIM_TOKEN",
		),
	),
	superadmins: Config.option(Config.schema(SuperadminsSchema, "SUPERADMINS")),
};
