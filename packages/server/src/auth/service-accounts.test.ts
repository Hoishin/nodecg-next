import { createHash } from "node:crypto";

import { NodeCrypto } from "@effect/platform-node";
import {
	AccountId,
	ServerIdentity,
	ServiceAccount,
	ServiceAccountId,
	User,
	UserId,
} from "@nodecg-next/internal";
import { testLayer } from "@nodecg-next/test-utils";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, describe, expect, vi } from "vitest";

import {
	type AccountRepository,
	AccountRepositoryService,
} from "../services/repository/account/account-repository.ts";
import {
	type ServiceAccountRepository,
	ServiceAccountRepositoryService,
} from "../services/repository/service-account/service-account-repository.ts";
import { TransactionService } from "../services/transaction/transaction.ts";
import {
	createServiceAccount,
	NotAUser,
	ServerCreatorNotImplemented,
} from "./service-accounts.ts";

const id = ServiceAccountId.make("00000000-0000-4000-8000-000000000001");
const bossAccountId = AccountId.make("boss-account");

const create = vi.fn<ServiceAccountRepository["create"]>(() =>
	Effect.succeed({
		serviceAccountId: id,
		accountId: AccountId.make("scoreboard-account"),
	}),
);
const resolveByAuthentication = vi.fn<
	AccountRepository["resolveByAuthentication"]
>(() => Effect.succeedSome(bossAccountId));
const addKey = vi.fn<ServiceAccountRepository["addKey"]>(() => Effect.void);

afterEach(() => {
	for (const mock of [create, resolveByAuthentication, addKey]) {
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
			grantRole: vi.fn(),
			revokeRole: vi.fn(),
		}),
		Layer.succeed(AccountRepositoryService, { resolveByAuthentication }),
		Layer.succeed(TransactionService, { wrap: (effect) => effect }),
	),
);

const admin = User.make({
	id: UserId.make("boss"),
	authentication: { issuer: "dev", subject: "boss" },
	displayName: "Boss",
	roles: [],
	globalRoles: ["admin"],
});

describe("createServiceAccount", () => {
	test(
		"creates the service account under a creating user's account and stores the hash of the returned key unlabelled",
		Effect.gen(function* () {
			const created = yield* createServiceAccount("scoreboard", admin);
			const hash = createHash("sha256")
				.update(Redacted.value(created.token))
				.digest("base64url");

			expect(resolveByAuthentication).toHaveBeenCalledExactlyOnceWith(
				admin.authentication,
			);
			expect(create).toHaveBeenCalledExactlyOnceWith({
				displayName: "scoreboard",
				createdBy: bossAccountId,
			});
			expect(addKey).toHaveBeenCalledExactlyOnceWith(id, { hash, label: "" });
		}),
	);

	test(
		"fails with NotAUser when the creating user has no account",
		Effect.gen(function* () {
			resolveByAuthentication.mockReturnValueOnce(Effect.succeedNone);

			const error = yield* createServiceAccount("scoreboard", admin).pipe(
				Effect.flip,
			);

			expect(error).toStrictEqual(NotAUser.make());
			expect(create).not.toHaveBeenCalled();
		}),
	);

	test(
		"fails with NotAUser when a service account creates one",
		Effect.gen(function* () {
			const provisioner = ServiceAccount.make({
				id: ServiceAccountId.make("00000000-0000-4000-8000-000000000002"),
				displayName: "provisioner",
				roles: [],
				globalRoles: ["admin"],
			});

			const error = yield* createServiceAccount("scoreboard", provisioner).pipe(
				Effect.flip,
			);

			expect(error).toStrictEqual(NotAUser.make());
			expect(create).not.toHaveBeenCalled();
		}),
	);

	test(
		"fails with ServerCreatorNotImplemented when the server creates one",
		Effect.gen(function* () {
			const error = yield* createServiceAccount(
				"scoreboard",
				ServerIdentity.make({}),
			).pipe(Effect.flip);

			expect(error).toStrictEqual(ServerCreatorNotImplemented.make());
			expect(create).not.toHaveBeenCalled();
		}),
	);

	test(
		"creates the service account and its first key in one transaction",
		Effect.gen(function* () {
			const begin = vi.fn();
			const commit = vi.fn();
			yield* createServiceAccount("scoreboard", admin).pipe(
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
