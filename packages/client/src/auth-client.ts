import {
	InternalApi,
	type Role,
	RoleName,
	type LoginProvider,
	UserId,
} from "@nodecg-next/internal";
import { Effect, ManagedRuntime, Schema } from "effect";
import { FetchHttpClient, Url, UrlParams } from "effect/http";
import { HttpApiClient } from "effect/http-api";

export class AuthRequestFailed extends Schema.TaggedError<AuthRequestFailed>()(
	"AuthRequestFailed",
	{ cause: Schema.Defect() },
) {
	override readonly message = "Authentication request failed";
}

export interface RoleAssignment {
	readonly userId: string;
	readonly role: typeof Role.Encoded;
}

export const loginUrl = (provider: LoginProvider, returnTo?: string) => {
	const params = UrlParams.setAll({ returnTo });
	return Url.modifyUrlParams(provider.url, params).href;
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

	const listUsers = Effect.fn("listUsers")(function* () {
		return yield* api.Users.list().pipe(Effect.mapError(requestFailed));
	});

	const grantRole = Effect.fn("grantRole")(function* (
		assignment: RoleAssignment,
	) {
		yield* api.Users.grantRole({
			params: { id: UserId.make(assignment.userId) },
			payload: {
				namespace: assignment.role.namespace,
				name: RoleName(assignment.role.name),
			},
		}).pipe(Effect.mapError(requestFailed));
	});

	const revokeRole = Effect.fn("revokeRole")(function* (
		assignment: RoleAssignment,
	) {
		yield* api.Users.revokeRole({
			params: { id: UserId.make(assignment.userId) },
			payload: {
				namespace: assignment.role.namespace,
				name: RoleName(assignment.role.name),
			},
		}).pipe(Effect.mapError(requestFailed));
	});

	return { providers, me, logout, listUsers, grantRole, revokeRole };
});

export const adaptAuthClient = <R, E>(
	runtime: ManagedRuntime.ManagedRuntime<R, E>,
	client: Effect.Success<ReturnType<typeof makeAuthClient>>,
) => ({
	providers: () => runtime.runPromise(client.providers()),
	me: () => runtime.runPromise(client.me()),
	logout: () => runtime.runPromise(client.logout()),
	listUsers: () => runtime.runPromise(client.listUsers()),
	grantRole: (assignment: RoleAssignment) =>
		runtime.runPromise(client.grantRole(assignment)),
	revokeRole: (assignment: RoleAssignment) =>
		runtime.runPromise(client.revokeRole(assignment)),
});

export function loadAuthClient(baseUrl?: string) {
	const runtime = ManagedRuntime.make(FetchHttpClient.layer);
	const client = runtime.runSync(makeAuthClient(baseUrl));

	return {
		...adaptAuthClient(runtime, client),
		dispose: () => void runtime.dispose(),
	};
}

export type AuthClient = ReturnType<typeof loadAuthClient>;
