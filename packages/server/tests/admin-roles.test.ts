import {
	AdminServiceAccountTargetSchema,
	AdminUserTargetSchema,
	Authentication,
	ServiceAccountId,
} from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { ConfigProvider, Crypto, Effect, HashMap, Layer } from "effect";
import { HttpBody } from "effect/unstable/http";
import { describe, expect } from "vitest";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "../src/auth/auth-provider.ts";
import { RoleRepositoryService } from "../src/services/repository/role/role-repository.ts";
import {
	buildClient,
	createServiceAccount,
	findAccountId,
	login,
	services,
} from "./setup.ts";

const test = testLayer(services);

const dev: AuthProvider = {
	name: "dev",
	issuer: "dev",
	authorize: () => Effect.die("unused"),
	callback: () => Effect.die("unused"),
};

const rootInConfig = Layer.mergeAll(
	Layer.succeed(AuthProviderRegistry, HashMap.make(["dev", dev])),
	ConfigProvider.layer(
		ConfigProvider.fromEnvRecord({ SUPERADMINS: "dev:root" }),
	),
);

const grantUrl = "http://x/api/internal/admin-roles/grant";
const revokeUrl = "http://x/api/internal/admin-roles/revoke";
const serviceAccountsUrl = "http://x/api/internal/service-accounts";
const claimUrl = "http://x/api/internal/authentication/claim-superadmin";

const operator = Authentication.make({ issuer: "dev", subject: "operator" });
const root = Authentication.make({ issuer: "dev", subject: "root" });
const admin = Authentication.make({ issuer: "dev", subject: "admin" });

const operatorTarget = AdminUserTargetSchema.make({ authentication: operator });
const rootTarget = AdminUserTargetSchema.make({ authentication: root });

describe("user", () => {
	test(
		"superadmin grants and revokes the admin tier",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const roles = yield* RoleRepositoryService;
			yield* login(client, operator);
			const operatorId = yield* findAccountId(operator);
			const asRoot = yield* login(client, root);

			for (const role of ["admin", "superadmin"]) {
				const grantRes = yield* asRoot.post(grantUrl, {
					body: yield* HttpBody.json({ target: operatorTarget, role }),
				});
				expect(grantRes.status).toBe(204);

				const granted = yield* roles.read(operatorId);
				expect(granted.globalRoles).toStrictEqual([role]);

				const revokeRes = yield* asRoot.post(revokeUrl, {
					body: yield* HttpBody.json({ target: operatorTarget, role }),
				});
				expect(revokeRes.status).toBe(204);

				const revoked = yield* roles.read(operatorId);
				expect(revoked.globalRoles).toStrictEqual([]);
			}
		}).pipe(Effect.provide(rootInConfig)),
	);

	test(
		"404 when granting to an authentication without an account",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const asRoot = yield* login(client, root);

			const res = yield* asRoot.post(grantUrl, {
				body: yield* HttpBody.json({ target: operatorTarget, role: "admin" }),
			});
			expect(res.status).toBe(404);
		}).pipe(Effect.provide(rootInConfig)),
	);

	test(
		"403 when revoking superadmin from a superadmin in config",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const asRoot = yield* login(client, root);

			const res = yield* asRoot.post(revokeUrl, {
				body: yield* HttpBody.json({ target: rootTarget, role: "superadmin" }),
			});
			expect(res.status).toBe(403);
			expect(yield* res.json).toMatchObject({
				message:
					"This superadmin comes from NODECG_SUPERADMINS and can only be revoked by removing the entry there",
			});
		}).pipe(Effect.provide(rootInConfig)),
	);
});

describe("service account", () => {
	test(
		"superadmin grants and revokes the admin tier",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const asRoot = yield* login(client, root);
			const { id } = yield* createServiceAccount(asRoot, "bot");
			const target = AdminServiceAccountTargetSchema.make({
				id: ServiceAccountId.make(id),
			});

			const grantRes = yield* asRoot.post(grantUrl, {
				body: yield* HttpBody.json({ target, role: "admin" }),
			});
			expect(grantRes.status).toBe(204);

			const listAfterGrantRes = yield* asRoot.get(serviceAccountsUrl);
			expect(yield* listAfterGrantRes.json).toEqual({
				serviceAccounts: [
					{ id, displayName: "bot", roles: [], globalRoles: ["admin"] },
				],
			});

			const revokeRes = yield* asRoot.post(revokeUrl, {
				body: yield* HttpBody.json({ target, role: "admin" }),
			});
			expect(revokeRes.status).toBe(204);

			const listAfterRevokeRes = yield* asRoot.get(serviceAccountsUrl);
			expect(yield* listAfterRevokeRes.json).toEqual({
				serviceAccounts: [
					{ id, displayName: "bot", roles: [], globalRoles: [] },
				],
			});
		}).pipe(Effect.provide(rootInConfig)),
	);

	test(
		"404 when granting to an unknown service account",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const crypto = yield* Crypto.Crypto;
			const target = AdminServiceAccountTargetSchema.make({
				id: ServiceAccountId.make(yield* crypto.randomUUIDv7),
			});
			const asRoot = yield* login(client, root);

			const res = yield* asRoot.post(grantUrl, {
				body: yield* HttpBody.json({ target, role: "admin" }),
			});
			expect(res.status).toBe(404);
		}).pipe(Effect.provide(rootInConfig)),
	);
});

describe("superadmin claim", () => {
	test(
		"revoking the last superadmin reopens the claim",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const roles = yield* RoleRepositoryService;
			const asRoot = yield* login(client, root);
			yield* roles.grantGlobalRole(yield* findAccountId(root), "superadmin");

			const claimWhileHeldRes = yield* asRoot.post(claimUrl, {
				body: yield* HttpBody.json({ token: "super-secret-claim-token" }),
			});
			expect(claimWhileHeldRes.status).toBe(403);

			const revokeRes = yield* asRoot.post(revokeUrl, {
				body: yield* HttpBody.json({ target: rootTarget, role: "superadmin" }),
			});
			expect(revokeRes.status).toBe(204);

			const claimAfterRevokeRes = yield* asRoot.post(claimUrl, {
				body: yield* HttpBody.json({ token: "super-secret-claim-token" }),
			});
			expect(claimAfterRevokeRes.status).toBe(204);
		}).pipe(
			Effect.provide(
				ConfigProvider.layer(
					ConfigProvider.fromEnvRecord({
						SUPERADMIN_CLAIM_TOKEN: "super-secret-claim-token",
					}),
				),
			),
		),
	);
});

describe("permission", () => {
	test(
		"401 for an anonymous caller",
		Effect.gen(function* () {
			const client = yield* buildClient;

			const grantRes = yield* client.post(grantUrl, {
				body: yield* HttpBody.json({ target: operatorTarget, role: "admin" }),
			});
			expect(grantRes.status).toBe(401);

			const revokeRes = yield* client.post(revokeUrl, {
				body: yield* HttpBody.json({ target: operatorTarget, role: "admin" }),
			});
			expect(revokeRes.status).toBe(401);
		}),
	);

	test(
		"403 for an admin-tier caller who is not a superadmin",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const roles = yield* RoleRepositoryService;
			const asAdmin = yield* login(client, admin);
			yield* roles.grantGlobalRole(yield* findAccountId(admin), "admin");

			const res = yield* asAdmin.post(grantUrl, {
				body: yield* HttpBody.json({ target: operatorTarget, role: "admin" }),
			});
			expect(res.status).toBe(403);
		}),
	);
});

describe("validation", () => {
	test(
		"400 for a role outside the admin tier",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const asRoot = yield* login(client, root);

			const res = yield* asRoot.post(grantUrl, {
				body: yield* HttpBody.json({
					target: operatorTarget,
					role: "producer",
				}),
			});
			expect(res.status).toBe(400);
		}).pipe(Effect.provide(rootInConfig)),
	);
});
