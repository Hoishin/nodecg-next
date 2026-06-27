import {
	HttpApiBuilder,
	HttpApiError,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { CurrentIdentity, NodecgApi } from "@nodecg/internal";
import {
	type Duration,
	Effect,
	Either,
	HashMap,
	Layer,
	Match,
	Option,
} from "effect";

import { AuthProviderRegistry } from "../auth/auth-provider.ts";
import { AuthenticationMiddlewareLive } from "../auth/middleware.ts";
import { sessionCookieName } from "../auth/session-cookie-name.ts";
import { buildFieldRegistry } from "../field-registry.ts";
import type { LoadedNamespace } from "../load-namespace.ts";
import { config } from "../server-config.ts";
import { SessionStoreService } from "../services/session-store/session-store.ts";
import { StashStoreService } from "../services/stash-store/stash-store.ts";

const stashCookieName = "nodecg.login";

const addCookie =
	(name: string, value: string, maxAge: Duration.DurationInput) =>
	(response: HttpServerResponse.HttpServerResponse) =>
		response.pipe(
			HttpServerResponse.setCookie(name, value, {
				httpOnly: true,
				sameSite: "lax",
				secure: false,
				path: "/",
				maxAge,
			}),
			// TODO: is this a correct silencing?
			Effect.catchTag(
				"CookieError",
				() => new HttpApiError.InternalServerError(),
			),
		);

const clearStash = addCookie(stashCookieName, "", 0);

const callbackUri = (origin: string, provider: string) =>
	`${origin}/api/authentication/callback/${provider}`;

const AuthenticationGroupLive = HttpApiBuilder.group(
	NodecgApi,
	"Authentication",
	(handlers) =>
		Effect.gen(function* () {
			const ttl = yield* config.sessionTtl;
			const origin = yield* config.origin;
			const registry = yield* AuthProviderRegistry;
			const sessions = yield* SessionStoreService;
			const stashes = yield* StashStoreService;

			return handlers
				.handle("me", () =>
					Effect.gen(function* () {
						const identity = yield* CurrentIdentity;
						return { identity };
					}),
				)
				.handle("login", ({ path: { provider: name } }) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const provider = HashMap.get(registry, name);
						if (Option.isNone(provider)) {
							return HttpServerResponse.text(
								"Unknown authentication provider",
								{ status: 404 },
							);
						}
						const redirect = yield* provider.value.authorize({
							redirectUri: callbackUri(origin, name),
							searchParams: new URL(request.url, "http://example.com")
								.searchParams,
						});
						const stashId = yield* stashes.create(redirect.stash);
						return yield* HttpServerResponse.redirect(redirect.url, {
							status: 302,
						}).pipe(addCookie(stashCookieName, stashId, "10 minutes")); // TODO: avoid hard-coded duration
					}),
				)
				.handle("callback", ({ path: { provider: name } }) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const provider = HashMap.get(registry, name);
						if (Option.isNone(provider)) {
							return HttpServerResponse.text(
								"Unknown authentication provider",
								{
									status: 404,
								},
							);
						}
						const stashId = request.cookies[stashCookieName];
						if (typeof stashId === "undefined") {
							return HttpServerResponse.text("Invalid or missing login state", {
								status: 400,
							});
						}
						const stash = yield* stashes.lookup(stashId);
						if (Option.isNone(stash)) {
							return HttpServerResponse.text("Invalid or missing login state", {
								status: 400,
							});
						}
						yield* stashes.revoke(stashId);
						const identity = yield* provider.value
							.callback({
								redirectUri: callbackUri(origin, name),
								searchParams: new URL(request.url, "http://example.com")
									.searchParams,
								stash: stash.value,
							})
							.pipe(Effect.either);
						if (Either.isLeft(identity)) {
							return yield* Match.value(identity.left).pipe(
								Match.tag("StateMismatchError", () =>
									HttpServerResponse.text("State mismatch", {
										status: 400,
									}).pipe(clearStash),
								),
								Match.exhaustive,
							);
						}
						const sessionId = yield* sessions.create(identity.right);
						return yield* HttpServerResponse.redirect("/", {
							status: 302,
						}).pipe(
							addCookie(sessionCookieName, sessionId, ttl),
							Effect.andThen(clearStash),
						);
					}),
				)
				.handle("logout", () =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;
						const sessionId = request.cookies[sessionCookieName];
						if (typeof sessionId !== "undefined") {
							yield* sessions.revoke(sessionId);
						}
						return yield* HttpServerResponse.empty({ status: 204 }).pipe(
							addCookie(sessionCookieName, "", 0),
						);
					}),
				);
		}),
);

export const buildNodecgApi = (options: {
	namespaces: ReadonlyArray<LoadedNamespace>;
}) => {
	const registry = buildFieldRegistry(options.namespaces);

	const HealthGroupLive = HttpApiBuilder.group(
		NodecgApi,
		"Health",
		(handlers) => handlers.handle("ping", () => Effect.succeed("pong")),
	);

	const StateGroupLive = HttpApiBuilder.group(NodecgApi, "State", (handlers) =>
		handlers
			.handle("get", ({ path: { namespace, name } }) =>
				Effect.gen(function* () {
					const field = registry.state.get(namespace)?.get(name);
					if (typeof field === "undefined") {
						return yield* new HttpApiError.NotFound();
					}
					return yield* field.getEncoded().pipe(
						Effect.catchTags({
							StateNotFound: () => new HttpApiError.NotFound(),
						}),
					);
				}),
			)
			.handle("update", ({ path: { namespace, name }, payload }) =>
				Effect.gen(function* () {
					const field = registry.state.get(namespace)?.get(name);
					if (typeof field === "undefined") {
						return yield* new HttpApiError.NotFound();
					}
					yield* field.setEncoded(payload).pipe(
						Effect.mapError((error) =>
							Match.value(error).pipe(
								Match.tag(
									"StateDecodeError",
									() => new HttpApiError.BadRequest(),
								),
								Match.tag("StateNotFound", () => new HttpApiError.NotFound()),
								Match.exhaustive,
							),
						),
					);
				}),
			),
	);

	const ComputedGroupLive = HttpApiBuilder.group(
		NodecgApi,
		"Computed",
		(handlers) =>
			handlers.handle("get", ({ path: { namespace, name } }) =>
				Effect.gen(function* () {
					const field = registry.computed.get(namespace)?.get(name);
					if (typeof field === "undefined") {
						return yield* new HttpApiError.NotFound();
					}
					return yield* field.getEncoded().pipe(
						Effect.catchTags({
							StateNotFound: () => new HttpApiError.NotFound(),
							StateComputeError: () => new HttpApiError.InternalServerError(),
							StateEncodeError: () => new HttpApiError.InternalServerError(),
						}),
					);
				}),
			),
	);

	return HttpApiBuilder.api(NodecgApi).pipe(
		Layer.provide(HealthGroupLive),
		Layer.provide(StateGroupLive),
		Layer.provide(ComputedGroupLive),
		Layer.provide(AuthenticationGroupLive),
		Layer.provide(AuthenticationMiddlewareLive),
	);
};
