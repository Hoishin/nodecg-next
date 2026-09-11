import {
	loadAuthClient,
	loginUrl,
	type AuthClient,
	type HumanIdentity,
	type Identity,
	type LoginProvider,
	type MePayload,
} from "@nodecg-next/client";
import { AnonymousIdentitySchema } from "@nodecg-next/internal";
import { Duration, Effect, Option, Schedule, Schema } from "effect";

import { nodecgBase } from "./base.ts";

export class LoginWindowBlocked extends Schema.TaggedError<LoginWindowBlocked>()(
	"LoginWindowBlocked",
	{},
) {
	override readonly message = "The browser blocked the login popup";
}

export class LoginAbandoned extends Schema.TaggedError<LoginAbandoned>()(
	"LoginAbandoned",
	{ reason: Schema.Literals(["closed", "timeout"]) },
) {
	override readonly message = `Login was abandoned before completing (popup ${this.reason})`;
}

export interface AuthSession {
	readonly client: AuthClient;
	readonly identity: {
		readonly get: () => Identity | undefined;
		readonly subscribe: (callback: () => void) => () => void;
	};
	readonly popupLogin: (provider: LoginProvider) => Promise<HumanIdentity>;
	readonly logout: () => Promise<void>;
	readonly refresh: () => Promise<MePayload>;
}

// TODO: use postMessage instead
const watchLoginSession = (client: AuthClient, popup: Window) =>
	Effect.gen(function* () {
		const closed = popup.closed;
		const payload = yield* Effect.promise(() => client.me());
		if (payload.identity._tag === "human") {
			return Option.some(payload.identity);
		}
		if (closed) {
			return yield* LoginAbandoned.make({ reason: "closed" });
		}
		return Option.none();
	}).pipe(
		Effect.repeat({
			schedule: Schedule.spaced(Duration.millis(500)),
			until: Option.isSome<HumanIdentity>,
		}),
		Effect.map((found) => found.value),
		Effect.timeoutOrElse({
			duration: Duration.minutes(5),
			orElse: () => LoginAbandoned.make({ reason: "timeout" }),
		}),
	);

export const authSession = (
	client: AuthClient = loadAuthClient(nodecgBase()),
): AuthSession => {
	const listeners = new Set<() => void>();
	let current: Identity | undefined;
	const setIdentity = (identity: Identity) => {
		current = identity;
		for (const listener of listeners) {
			listener();
		}
	};

	const refresh = async () => {
		const payload = await client.me();
		setIdentity(payload.identity);
		return payload;
	};
	void refresh().catch(() => undefined);

	const popupLogin = (provider: LoginProvider) =>
		Effect.gen(function* () {
			const url = yield* Effect.fromResult(loginUrl(provider));
			const popup = yield* Effect.acquireRelease(
				Effect.gen(function* () {
					const opened = window.open(url, "nodecg-login");
					if (opened === null) {
						return yield* LoginWindowBlocked.make();
					}
					return opened;
				}),
				(opened) => Effect.sync(() => opened.close()),
			);
			const human = yield* watchLoginSession(client, popup);
			setIdentity(human);
			return human;
		}).pipe(Effect.scoped, Effect.runPromise);

	const logout = async () => {
		await client.logout();
		setIdentity(AnonymousIdentitySchema.make({}));
	};

	return {
		client,
		identity: {
			get: () => current,
			subscribe: (callback) => {
				listeners.add(callback);
				return () => {
					listeners.delete(callback);
				};
			},
		},
		popupLogin,
		logout,
		refresh,
	};
};
