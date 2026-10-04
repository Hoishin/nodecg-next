import {
	AdminServiceAccountTargetSchema,
	AdminUserTargetSchema,
	CreateApiKeyResultSchema,
	ServiceAccountId,
} from "@nodecg-next/internal";
import { ConfigProvider, Effect, HashMap, Layer } from "effect";
import { HttpBody, HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vitest";

import {
	type AuthProvider,
	AuthProviderRegistry,
} from "../src/auth/auth-provider.ts";
import { RoleRepositoryService } from "../src/services/repository/role/role-repository.ts";
import { buildClient, createAccount, login, test } from "./setup.ts";

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

const operator = AdminUserTargetSchema.make({
	authentication: { issuer: "dev", subject: "operator" },
});
const root = AdminUserTargetSchema.make({
	authentication: { issuer: "dev", subject: "root" },
});

describe("user", () => {
	test(
		"superadmin grants and revokes the admin tier",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const roles = yield* RoleRepositoryService;
			const operatorId = yield* createAccount("dev", "operator");
			const asRoot = yield* client.pipe(login("dev", "root"));

			for (const role of ["admin", "superadmin"]) {
				const grant = yield* asRoot.post(grantUrl, {
					body: yield* HttpBody.json({ target: operator, role }),
				});
				expect(grant.status).toBe(204);
				const granted = yield* roles.read(operatorId);
				expect(granted.globalRoles).toStrictEqual([role]);

				const revoke = yield* asRoot.post(revokeUrl, {
					body: yield* HttpBody.json({ target: operator, role }),
				});
				expect(revoke.status).toBe(204);
				const revoked = yield* roles.read(operatorId);
				expect(revoked.globalRoles).toStrictEqual([]);
			}
		}).pipe(Effect.provide(rootInConfig)),
	);

	test(
		"404 when granting to an authentication without an account",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const asRoot = yield* client.pipe(login("dev", "root"));

			const grant = yield* asRoot.post(grantUrl, {
				body: yield* HttpBody.json({ target: operator, role: "admin" }),
			});
			expect(grant.status).toBe(404);
		}).pipe(Effect.provide(rootInConfig)),
	);

	test(
		"403 when revoking superadmin from a superadmin in config",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const asRoot = yield* client.pipe(login("dev", "root"));

			const res = yield* asRoot.post(revokeUrl, {
				body: yield* HttpBody.json({ target: root, role: "superadmin" }),
			});
			expect(res.status).toBe(403);
			const body = yield* res.json;
			expect(body).toMatchObject({
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
			const asRoot = yield* client.pipe(login("dev", "root"));
			const { id } = yield* asRoot
				.post(serviceAccountsUrl, {
					body: yield* HttpBody.json({ displayName: "bot" }),
				})
				.pipe(
					Effect.flatMap(
						HttpClientResponse.schemaBodyJson(CreateApiKeyResultSchema),
					),
				);
			const target = AdminServiceAccountTargetSchema.make({
				id: ServiceAccountId.make(id),
			});

			const grant = yield* asRoot.post(grantUrl, {
				body: yield* HttpBody.json({ target, role: "admin" }),
			});
			expect(grant.status).toBe(204);
			const listedAfterGrant = yield* asRoot
				.get(serviceAccountsUrl)
				.pipe(Effect.flatMap((res) => res.json));
			expect(listedAfterGrant).toEqual({
				serviceAccounts: [
					{ id, displayName: "bot", roles: [], globalRoles: ["admin"] },
				],
			});

			const revoke = yield* asRoot.post(revokeUrl, {
				body: yield* HttpBody.json({ target, role: "admin" }),
			});
			expect(revoke.status).toBe(204);
			const listedAfterRevoke = yield* asRoot
				.get(serviceAccountsUrl)
				.pipe(Effect.flatMap((res) => res.json));
			expect(listedAfterRevoke).toEqual({
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
			const asRoot = yield* client.pipe(login("dev", "root"));

			const grant = yield* asRoot.post(grantUrl, {
				body: yield* HttpBody.json({
					target: AdminServiceAccountTargetSchema.make({
						id: ServiceAccountId.make("00000000-0000-4000-8000-0000000000ff"),
					}),
					role: "admin",
				}),
			});
			expect(grant.status).toBe(404);
		}).pipe(Effect.provide(rootInConfig)),
	);
});

describe("superadmin claim", () => {
	test(
		"revoking the last superadmin reopens the claim",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const roles = yield* RoleRepositoryService;
			yield* roles.grantGlobalRole(
				yield* createAccount("dev", "root"),
				"superadmin",
			);
			const asRoot = yield* client.pipe(login("dev", "root"));
			const claimUrl = "http://x/api/internal/authentication/claim-superadmin";

			const claimWhileRootHolds = yield* asRoot.post(claimUrl, {
				body: yield* HttpBody.json({ token: "super-secret-claim-token" }),
			});
			expect(claimWhileRootHolds.status).toBe(403);

			const revokeOwn = yield* asRoot.post(revokeUrl, {
				body: yield* HttpBody.json({ target: root, role: "superadmin" }),
			});
			expect(revokeOwn.status).toBe(204);
			const claimAfterLastRevoke = yield* asRoot.post(claimUrl, {
				body: yield* HttpBody.json({ token: "super-secret-claim-token" }),
			});
			expect(claimAfterLastRevoke.status).toBe(204);
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

			const grant = yield* client.post(grantUrl, {
				body: yield* HttpBody.json({ target: operator, role: "admin" }),
			});
			expect(grant.status).toBe(401);
			const revoke = yield* client.post(revokeUrl, {
				body: yield* HttpBody.json({ target: operator, role: "admin" }),
			});
			expect(revoke.status).toBe(401);
		}),
	);

	test(
		"403 for an admin-tier caller who is not a superadmin",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const roles = yield* RoleRepositoryService;
			yield* roles.grantGlobalRole(
				yield* createAccount("dev", "admin"),
				"admin",
			);
			const asAdmin = yield* client.pipe(login("dev", "admin"));

			const grant = yield* asAdmin.post(grantUrl, {
				body: yield* HttpBody.json({ target: operator, role: "admin" }),
			});
			expect(grant.status).toBe(403);
		}),
	);
});

describe("validation", () => {
	test(
		"400 for a role outside the admin tier",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const asRoot = yield* client.pipe(login("dev", "root"));

			const grant = yield* asRoot.post(grantUrl, {
				body: yield* HttpBody.json({ target: operator, role: "producer" }),
			});
			expect(grant.status).toBe(400);
		}).pipe(Effect.provide(rootInConfig)),
	);
});
