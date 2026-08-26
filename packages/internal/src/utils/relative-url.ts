import { Url, UrlParams } from "@effect/platform";
import { Either, Schema } from "effect";

export class MalformedUrl extends Schema.TaggedError<MalformedUrl>()(
	"MalformedUrl",
	{ url: Schema.String, cause: Schema.Defect },
) {
	override readonly message = `URL "${this.url}" is malformed`;
}

const parseWithPlaceholder = (url: string) =>
	Url.fromString(url, "http://placeholder").pipe(
		Either.mapLeft((cause) => new MalformedUrl({ url, cause })),
	);

export const parseRelativeUrl = (url: string) =>
	parseWithPlaceholder(url).pipe(
		Either.map((parsed) => ({
			pathname: parsed.pathname,
			search: parsed.search,
		})),
	);

export const buildRelativeUrl = (url: string, params: UrlParams.Input) =>
	parseWithPlaceholder(url).pipe(
		Either.map((parsed) =>
			Url.modifyUrlParams(parsed, UrlParams.setAll(params)),
		),
		Either.map((updated) => updated.pathname + updated.search),
	);
