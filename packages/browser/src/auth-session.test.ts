import type { AuthClient, MePayload } from "@nodecg/client";
import { AnonymousIdentitySchema, HumanIdentitySchema } from "@nodecg/internal";
import { describe, expect, test, vi } from "vitest";

import { authSession } from "./auth-session.ts";

const humanIdentity = HumanIdentitySchema.make({
	account: { issuer: "dev", subject: "alice", displayName: "Alice" },
	roles: new Set(),
});

const humanPayload: MePayload = { identity: humanIdentity, namespaces: {} };

const stubClient = () => {
	const providers = vi.fn<AuthClient["providers"]>(async () => []);
	const me = vi.fn<AuthClient["me"]>(async () => humanPayload);
	const logout = vi.fn<AuthClient["logout"]>(async () => undefined);
	const grantRole = vi.fn<AuthClient["grantRole"]>(async () => new Set());
	const revokeRole = vi.fn<AuthClient["revokeRole"]>(async () => new Set());
	const dispose = vi.fn();
	const client: AuthClient = {
		providers,
		me,
		logout,
		grantRole,
		revokeRole,
		dispose,
		[Symbol.dispose]: dispose,
	};
	return { client, me, logout };
};

describe("identity", () => {
	test("starts unloaded and is seeded by the boot-time refresh", async () => {
		const { client } = stubClient();
		const session = authSession(client);
		expect(session.identity.get()).toBeUndefined();
		await vi.waitFor(() => {
			expect(session.identity.get()).toEqual(humanIdentity);
		});
	});

	test("subscribe notifies on change until unsubscribed", async () => {
		const { client } = stubClient();
		const session = authSession(client);
		const changed = vi.fn();
		const unsubscribe = session.identity.subscribe(changed);

		await session.refresh();
		expect(changed).toHaveBeenCalled();

		unsubscribe();
		const calls = changed.mock.calls.length;
		await session.refresh();
		expect(changed.mock.calls.length).toBe(calls);
	});
});

describe("refresh", () => {
	test("returns the payload and reflects its identity into the store", async () => {
		const { client, me } = stubClient();
		const session = authSession(client);

		const payload = await session.refresh();

		expect(payload).toEqual(humanPayload);
		expect(session.identity.get()).toEqual(humanIdentity);
		expect(me).toHaveBeenCalled();
	});
});

describe("logout", () => {
	test("calls the client and sets the store to the anonymous identity", async () => {
		const { client, logout } = stubClient();
		const session = authSession(client);

		await session.logout();

		expect(logout).toHaveBeenCalled();
		expect(session.identity.get()).toEqual(AnonymousIdentitySchema.make());
	});
});
