import { authSession } from "@nodecg/browser";
import { loadAuthClient, type LoginProvider } from "@nodecg/client";
import { assert, describe, expect, onTestFinished, test, vi } from "vitest";
import { commands } from "vitest/browser";

import {
	grantAsAdmin,
	grantRole,
	login,
	logout,
	me,
	revokeAsAdmin,
} from "../../src/client/auth.ts";

describe("anonymous identity", () => {
	test("a request without a session resolves to the anonymous identity", async () => {
		await logout();
		expect((await me()).identity).toEqual({ _tag: "anonymous" });
	});
});

describe("browser login", () => {
	test("logging in establishes a session, logout tears it down", async () => {
		await login("alice");

		expect((await me()).identity).toEqual({
			_tag: "human",
			account: { issuer: "dev", subject: "alice", displayName: "Alice" },
			roles: new Set(),
		});

		await logout();
		expect((await me()).identity).toEqual({ _tag: "anonymous" });
	});
});

describe("role reporting", () => {
	test("anonymous holds no declared role", async () => {
		await logout();
		expect((await me()).namespaces["e2e"]?.roles).toEqual(new Set());
	});

	test("a held declared role reports for its namespace, capabilities or not", async () => {
		await grantAsAdmin("permsviewer", "viewer");
		await login("permsviewer");
		onTestFinished(async () => {
			await revokeAsAdmin("permsviewer", "viewer");
			await logout();
		});

		expect((await me()).namespaces["e2e"]?.roles).toEqual(new Set(["viewer"]));
	});
});

describe("loadAuthClient", () => {
	test("passes providers, me, and logout through to the live server", async () => {
		await logout();
		const client = loadAuthClient();
		onTestFinished(() => {
			client.dispose();
		});
		onTestFinished(async () => {
			await logout();
		});

		expect(await client.providers()).toEqual([
			{ name: "dev", url: "/api/internal/authentication/login/dev" },
		]);

		await login("alice");
		const payload = await client.me();
		assert(payload.identity._tag === "human");
		expect(payload.namespaces["e2e"]?.roles).toEqual(new Set());

		await client.logout();
		expect((await me()).identity).toEqual({ _tag: "anonymous" });
	});
});

describe("authSession", () => {
	test("popupLogin resolves the human identity, updates the store, and closes the popup", async () => {
		const session = authSession();
		onTestFinished(() => {
			session.client.dispose();
		});
		onTestFinished(async () => {
			await logout();
		});
		const changed = vi.fn();
		const unsubscribe = session.identity.subscribe(changed);
		onTestFinished(unsubscribe);
		const pagesBefore = await commands.countPages();

		const providers = await session.client.providers();
		const dev = providers.find((provider) => provider.name === "dev");
		assert(dev);

		const human = await session.popupLogin(dev);
		expect(human.account.subject).toBe("alice");
		expect(session.identity.get()).toEqual(human);
		expect(changed).toHaveBeenCalled();
		await vi.waitFor(async () => {
			expect(await commands.countPages()).toBe(pagesBefore);
		});
	});

	test("closing the popup mid-flow rejects with LoginAbandoned and leaves the store unchanged", async () => {
		await logout();
		const session = authSession();
		onTestFinished(() => {
			session.client.dispose();
		});
		await vi.waitFor(() => {
			expect(session.identity.get()).toEqual({ _tag: "anonymous" });
		});

		const missing: LoginProvider = {
			name: "missing",
			url: "/api/internal/authentication/login/missing",
		};
		const pending = session.popupLogin(missing);
		await commands.closeLoginPopup();
		await expect(pending).rejects.toThrow(/abandoned/i);
		expect(session.identity.get()).toEqual({ _tag: "anonymous" });
	});
});

describe("runtime role assignment", () => {
	test("a granted role rides on the resolved identity live, and revoke removes it", async () => {
		await login("operator");
		const before = (await me()).identity;
		assert(before._tag === "human");
		expect(before.roles).toEqual(new Set());

		await grantAsAdmin("operator", "producer");
		await login("operator");
		const granted = (await me()).identity;
		assert(granted._tag === "human");
		expect(granted.roles).toEqual(new Set(["producer"]));

		await revokeAsAdmin("operator", "producer");
		await login("operator");
		const revoked = (await me()).identity;
		assert(revoked._tag === "human");
		expect(revoked.roles).toEqual(new Set());

		await logout();
	});

	test("even an admin cannot grant an undeclarable role", async () => {
		await login("root");
		onTestFinished(async () => {
			await logout();
		});
		await expect(grantRole("operator", "server")).rejects.toThrow(
			"Authentication request failed",
		);
		await expect(grantRole("operator", "superadmin")).rejects.toThrow(
			"Authentication request failed",
		);
	});

	test("a caller without the admin tier cannot grant", async () => {
		await login("nobody");
		onTestFinished(async () => {
			await logout();
		});
		await expect(grantRole("nobody", "superadmin")).rejects.toThrow(
			"Authentication request failed",
		);
	});

	test("an anonymous caller cannot grant", async () => {
		await logout();
		await expect(grantRole("nobody", "superadmin")).rejects.toThrow(
			"Authentication request failed",
		);
	});
});
