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
	const write = vi.fn<ReplicantStorage["write"]>(() => Effect.void);
	const subscribe = vi.fn<ReplicantStorage["subscribe"]>(() =>
		Queue.unbounded<ReplicantChange>(),
	);
	const stub = {
		read,
		write,
		subscribe,
	} satisfies ReplicantStorage;
	const reset = () => {
		for (const mock of [read, write, subscribe]) {
			mock.mockReset();
		}
	};
	return { stub, reset };
};
