import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import {
	InternalApi,
	RoleName,
	type LoginProvider,
	type MePayload,
} from "@nodecg/internal";
import { Effect, ManagedRuntime, Schema } from "effect";

export class AuthRequestFailed extends Schema.TaggedError<AuthRequestFailed>()(
	"AuthRequestFailed",
	{ cause: Schema.Defect },
) {
	override readonly message = "Authentication request failed";
}

export interface RoleAssignment {
	readonly issuer: string;
	readonly subject: string;
	readonly role: string;
}

export interface AuthClient {
	readonly providers: () => Promise<ReadonlyArray<LoginProvider>>;
	readonly me: () => Promise<MePayload>;
	readonly logout: () => Promise<void>;
	readonly grantRole: (
		assignment: RoleAssignment,
	) => Promise<ReadonlySet<RoleName>>;
	readonly revokeRole: (
		assignment: RoleAssignment,
	) => Promise<ReadonlySet<RoleName>>;
	readonly dispose: () => void;
	readonly [Symbol.dispose]: () => void;
}

export const loginUrl = (
	provider: LoginProvider,
	returnTo?: string,
): string => {
	if (typeof returnTo === "undefined") {
		return provider.url;
	}
	const url = new URL(provider.url, "http://relative");
	url.searchParams.set("returnTo", returnTo);
	return url.pathname + url.search;
};

export const makeAuthClient = Effect.fn("makeAuthClient")(function* (
	baseUrl?: string,
) {
	const api = yield* HttpApiClient.make(
		InternalApi,
		baseUrl ? { baseUrl } : undefined,
	);

	const requestFailed = (cause: unknown) => new AuthRequestFailed({ cause });

	const providers = Effect.fn("providers")(function* () {
		return yield* api.Authentication.providers().pipe(
			Effect.mapError(requestFailed),
		);
	});

	const me = Effect.fn("me")(function* () {
		return yield* api.Authentication.me().pipe(Effect.mapError(requestFailed));
	});

	const logout = Effect.fn("logout")(function* () {
		yield* api.Authentication.logout().pipe(Effect.mapError(requestFailed));
	});

	const grantRole = Effect.fn("grantRole")(function* (
		assignment: RoleAssignment,
	) {
		const result = yield* api.Roles.grant({
			payload: { ...assignment, role: RoleName(assignment.role) },
		}).pipe(Effect.mapError(requestFailed));
		return result.roles;
	});

	const revokeRole = Effect.fn("revokeRole")(function* (
		assignment: RoleAssignment,
	) {
		const result = yield* api.Roles.revoke({
			payload: { ...assignment, role: RoleName(assignment.role) },
		}).pipe(Effect.mapError(requestFailed));
		return result.roles;
	});

	return { providers, me, logout, grantRole, revokeRole };
});

export function loadAuthClient(baseUrl?: string): AuthClient {
	const runtime = ManagedRuntime.make(FetchHttpClient.layer);
	const client = runtime.runSync(makeAuthClient(baseUrl));

	return {
		providers: () => runtime.runPromise(client.providers()),
		me: () => runtime.runPromise(client.me()),
		logout: () => runtime.runPromise(client.logout()),
		grantRole: (assignment) => runtime.runPromise(client.grantRole(assignment)),
		revokeRole: (assignment) =>
			runtime.runPromise(client.revokeRole(assignment)),
		dispose: () => void runtime.dispose(),
		[Symbol.dispose]: () => void runtime.dispose(),
	};
}
