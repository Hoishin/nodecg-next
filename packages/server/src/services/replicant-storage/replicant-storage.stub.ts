import { Effect, Queue } from "effect";
import { vi } from "vitest";

import {
	type ReplicantChange,
	type ReplicantStorage,
	ReplicantNotFound,
} from "./replicant-storage.ts";

export const createStorageStub = () => {
	const read = vi.fn<ReplicantStorage["read"]>(
		(namespace, name) => new ReplicantNotFound({ namespace, name }),
	);
	const create = vi.fn<ReplicantStorage["create"]>(() => Effect.void);
	const update = vi.fn<ReplicantStorage["update"]>(() => Effect.void);
	const subscribe = vi.fn<ReplicantStorage["subscribe"]>(() =>
		Queue.unbounded<ReplicantChange>(),
	);
	const flush = vi.fn<ReplicantStorage["flush"]>(() => Effect.void);
	const stub = {
		read,
		create,
		update,
		subscribe,
		flush,
	} satisfies ReplicantStorage;
	const reset = () => {
		for (const mock of [read, create, update, subscribe, flush]) {
			mock.mockReset();
		}
	};
	return { stub, reset };
};
