import { Result, Schema } from "effect";
import { Url, UrlParams } from "effect/unstable/http";

export class MalformedUrl extends Schema.TaggedError<MalformedUrl>()(
	"MalformedUrl",
	{ url: Schema.String, cause: Schema.Defect() },
) {
	override readonly message = `URL "${this.url}" is malformed`;
}

const parseWithPlaceholder = (url: string) =>
	Url.fromString(url, "http://placeholder").pipe(
		Result.mapError((cause) => new MalformedUrl({ url, cause })),
	);

export const parseRelativeUrl = (url: string) =>
	parseWithPlaceholder(url).pipe(
		Result.map((parsed) => ({
			pathname: parsed.pathname,
			search: parsed.search,
		})),
	);

export const buildRelativeUrl = (url: string, params: UrlParams.Input) =>
	parseWithPlaceholder(url).pipe(
		Result.map((parsed) =>
			Url.modifyUrlParams(parsed, UrlParams.setAll(params)),
		),
		Result.map((updated) => updated.pathname + updated.search),
	);
