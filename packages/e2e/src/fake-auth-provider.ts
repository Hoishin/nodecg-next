import { randomBytes } from "node:crypto";

import { type AuthProvider, StateMismatchError } from "@nodecg/server";
import { Effect } from "effect";

interface SeededIdentity {
	readonly id: string;
	readonly displayName: string;
}

export const makeFakeAuthProvider = (
	name: string,
	seeded: ReadonlyArray<SeededIdentity>,
): AuthProvider => {
	const identities = new Map(seeded.map((identity) => [identity.id, identity]));
	return {
		name,
		authorize: (input) =>
			Effect.sync(() => {
				const id = input.searchParams.get("as") ?? seeded[0]?.id ?? "";
				const state = randomBytes(16).toString("base64url");
				const url = new URL(input.redirectUri);
				url.searchParams.set("state", state);
				url.searchParams.set("identity", id);
				return {
					url: `${url.pathname}${url.search}`,
					stash: { provider: name, state },
				};
			}),
		callback: Effect.fn("FakeAuthProvider.callback")(function* (input) {
			if (input.searchParams.get("state") !== input.stash.state) {
				return yield* new StateMismatchError();
			}
			const id = input.searchParams.get("identity") ?? "";
			const found = identities.get(id);
			return {
				_tag: "human",
				issuer: name,
				subject: id,
				displayName: found?.displayName ?? id,
			};
		}),
	};
};
