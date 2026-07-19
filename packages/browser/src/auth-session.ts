import {
	loadAuthClient,
	type AuthClient,
	type HumanIdentity,
	type Identity,
	type LoginProvider,
	type MePayload,
} from "@nodecg/client";
import { AnonymousIdentitySchema } from "@nodecg/internal";
import { Schema } from "effect";

import { nodecgBase } from "./base.ts";

export class LoginWindowBlocked extends Schema.TaggedError<LoginWindowBlocked>()(
	"LoginWindowBlocked",
	{},
) {
	override readonly message = "The browser blocked the login popup";
}

export class LoginAbandoned extends Schema.TaggedError<LoginAbandoned>()(
	"LoginAbandoned",
	{ reason: Schema.Literal("closed", "timeout") },
) {
	override readonly message = `Login was abandoned before completing (popup ${this.reason})`;
}

interface LoginPopup {
	readonly closed: boolean;
	readonly close: () => void;
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

const sleep = (millis: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, millis));

// TODO: use postMessage instead
const watchLoginSession = async (
	client: AuthClient,
	popup: LoginPopup,
): Promise<HumanIdentity> => {
	const pollInterval = 500;
	const giveUpAfter = 5 * 60_000;
	const pollLimit = giveUpAfter / pollInterval;
	for (let polls = 0; polls < pollLimit; polls++) {
		const closed = popup.closed;
		const payload = await client.me();
		if (payload.identity._tag === "human") {
			return payload.identity;
		}
		if (closed) {
			throw new LoginAbandoned({ reason: "closed" });
		}
		await sleep(pollInterval);
	}
	throw new LoginAbandoned({ reason: "timeout" });
};

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

	const popupLogin = async (provider: LoginProvider) => {
		const popup = window.open(provider.url, "nodecg-login");
		if (popup === null) {
			throw new LoginWindowBlocked();
		}
		try {
			const human = await watchLoginSession(client, popup);
			setIdentity(human);
			return human;
		} finally {
			popup.close();
		}
	};

	const logout = async () => {
		await client.logout();
		setIdentity(AnonymousIdentitySchema.make());
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
