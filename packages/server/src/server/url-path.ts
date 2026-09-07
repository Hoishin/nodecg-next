import { Effect, Path } from "effect";

/**
 * Path implementation used for URL pathnames. Always POSIX and platform agnostic.
 */
export const UrlPath = Path.Path.pipe(Effect.provide(Path.layer));
