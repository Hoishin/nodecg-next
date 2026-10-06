import { createHash } from "node:crypto";

import { NodeCrypto } from "@effect/platform-node";
import { ServiceAccountId, UserId } from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import {
	type ServiceAccountRepository,
	ServiceAccountRepositoryService,
} from "../services/repository/service-account/service-account-repository.ts";
import { TransactionService } from "../services/transaction/transaction.ts";
import { createServiceAccount } from "./service-accounts.ts";

const id = ServiceAccountId.make("00000000-0000-4000-8000-000000000001");
const adminId = UserId.make("admin-user");

const create = vi.fn<ServiceAccountRepository["create"]>(() =>
	Effect.succeed(id),
);
const addKey = vi.fn<ServiceAccountRepository["addKey"]>(() => Effect.void);

afterEach(() => {
	for (const mock of [create, addKey]) {
		mock.mockReset();
	}
});

const test = testLayer(
	Layer.mergeAll(
		NodeCrypto.layer,
		Layer.succeed(ServiceAccountRepositoryService, {
			create,
			createWithId: vi.fn(),
			resolveById: vi.fn(),
			resolveByKeyHash: vi.fn(),
			listAll: vi.fn(),
			addKey,
			replaceKey: vi.fn(),
			delete: vi.fn(),
			grantRoles: vi.fn(),
			revokeRoles: vi.fn(),
		}),
		Layer.succeed(TransactionService, { wrap: (effect) => effect }),
	),
);

describe("createServiceAccount", () => {
	test(
		"creates the service account and stores its key's hash",
		Effect.gen(function* () {
			const { token } = yield* createServiceAccount("scoreboard", adminId);
			const hash = createHash("sha256")
				.update(Redacted.value(token))
				.digest("base64url");

			expect(create).toHaveBeenCalledExactlyOnceWith({
				displayName: "scoreboard",
				createdBy: adminId,
			});
			expect(addKey).toHaveBeenCalledExactlyOnceWith(id, { hash, label: "" });
		}),
	);

	test(
		"creates the service account and its first key in one transaction",
		Effect.gen(function* () {
			const begin = vi.fn();
			const commit = vi.fn();
			yield* createServiceAccount("scoreboard", adminId).pipe(
				Effect.provideService(TransactionService, {
					wrap: (effect) => {
						begin();
						return effect.pipe(Effect.tap(() => Effect.sync(commit)));
					},
				}),
			);

			expect(begin).toHaveBeenCalledBefore(create);
			expect(addKey).toHaveBeenCalledBefore(commit);
		}),
	);
});
