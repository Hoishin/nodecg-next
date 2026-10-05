import {
	AccountId,
	Authentication,
	Role,
	RoleNameSchema,
} from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Crypto, Effect, Layer } from "effect";
import { HttpBody } from "effect/unstable/http";
import { describe, expect } from "vitest";

import { NamespaceRegistryService } from "../src/namespace-registry.ts";
import { RoleRepositoryService } from "../src/services/repository/role/role-repository.ts";
import {
	buildClient,
	findAccountId,
	login,
	loginAdmin,
	services,
} from "./setup.ts";

const producer = Role.make({
	namespace: "show",
	name: RoleNameSchema.make("producer"),
});

const test = testLayer(
	Layer.merge(
		services,
		NamespaceRegistryService.layer([
			{
				namespace: "show",
				declaredRoles: new Set([producer.name]),
				fields: { replicant: {}, computed: {}, topic: {}, rpc: {} },
			},
		]),
	),
);

const grantUrl = "http://x/api/internal/roles/grant";
const revokeUrl = "http://x/api/internal/roles/revoke";

const operator = Authentication.make({ issuer: "dev", subject: "operator" });
const admin = Authentication.make({ issuer: "dev", subject: "admin" });

describe("user", () => {
	test(
		"admin grants and revokes a role",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const roles = yield* RoleRepositoryService;
			const asAdmin = yield* loginAdmin(client, admin);

			yield* login(client, operator);
			const operatorId = yield* findAccountId(operator);

			const grantRes = yield* asAdmin.post(grantUrl, {
				body: yield* HttpBody.json({ accountId: operatorId, role: producer }),
			});
			expect(grantRes.status).toBe(204);

			const granted = yield* roles.read(operatorId);
			expect(granted.roles).toStrictEqual([producer]);

			const revokeRes = yield* asAdmin.post(revokeUrl, {
				body: yield* HttpBody.json({ accountId: operatorId, role: producer }),
			});
			expect(revokeRes.status).toBe(204);

			const revoked = yield* roles.read(operatorId);
			expect(revoked.roles).toStrictEqual([]);
		}),
	);
});

describe("unknown account", () => {
	test(
		"404 for an unknown account",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const crypto = yield* Crypto.Crypto;
			const accountId = AccountId.make(yield* crypto.randomUUIDv7);

			const asAdmin = yield* loginAdmin(client, admin);

			yield* login(client, operator);

			const grantRes = yield* asAdmin.post(grantUrl, {
				body: yield* HttpBody.json({ accountId, role: producer }),
			});
			expect(grantRes.status).toBe(404);

			const revokeRes = yield* asAdmin.post(revokeUrl, {
				body: yield* HttpBody.json({ accountId, role: producer }),
			});
			expect(revokeRes.status).toBe(404);
		}),
	);
});

describe("permission", () => {
	test(
		"401 for an anonymous caller",
		Effect.gen(function* () {
			const client = yield* buildClient;

			yield* login(client, operator);
			const operatorId = yield* findAccountId(operator);

			const grantRes = yield* client.post(grantUrl, {
				body: yield* HttpBody.json({ accountId: operatorId, role: producer }),
			});
			expect(grantRes.status).toBe(401);

			const revokeRes = yield* client.post(revokeUrl, {
				body: yield* HttpBody.json({ accountId: operatorId, role: producer }),
			});
			expect(revokeRes.status).toBe(401);
		}),
	);

	test(
		"403 for a caller below the admin tier",
		Effect.gen(function* () {
			const client = yield* buildClient;
			const roles = yield* RoleRepositoryService;

			const asOperator = yield* login(client, operator);
			const operatorId = yield* findAccountId(operator);
			yield* roles.grantRole(operatorId, producer);

			const res = yield* asOperator.post(grantUrl, {
				body: yield* HttpBody.json({ accountId: operatorId, role: producer }),
			});
			expect(res.status).toBe(403);
		}),
	);
});

describe("validation", () => {
	test(
		"400 for an undeclarable role",
		Effect.gen(function* () {
			const client = yield* buildClient;

			yield* login(client, operator);
			const operatorId = yield* findAccountId(operator);

			const asAdmin = yield* loginAdmin(client, admin);

			for (const name of ["superadmin", "admin", "server"]) {
				const grantRes = yield* asAdmin.post(grantUrl, {
					body: yield* HttpBody.json({
						accountId: operatorId,
						role: { namespace: "show", name },
					}),
				});
				expect(grantRes.status).toBe(400);

				const revokeRes = yield* asAdmin.post(revokeUrl, {
					body: yield* HttpBody.json({
						accountId: operatorId,
						role: { namespace: "show", name },
					}),
				});
				expect(revokeRes.status).toBe(400);
			}
		}),
	);

	test(
		"422 for a role the namespace does not declare",
		Effect.gen(function* () {
			const client = yield* buildClient;

			yield* login(client, operator);
			const operatorId = yield* findAccountId(operator);

			const asAdmin = yield* loginAdmin(client, admin);

			const undeclaredRoleRes = yield* asAdmin.post(grantUrl, {
				body: yield* HttpBody.json({
					accountId: operatorId,
					role: { namespace: "show", name: "ghost" },
				}),
			});
			expect(undeclaredRoleRes.status).toBe(422);

			const unknownNamespaceRes = yield* asAdmin.post(grantUrl, {
				body: yield* HttpBody.json({
					accountId: operatorId,
					role: { namespace: "stage", name: "producer" },
				}),
			});
			expect(unknownNamespaceRes.status).toBe(422);
		}),
	);
});
