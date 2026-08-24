import { Effect } from "effect";
import { vi } from "vitest";

import {
	type ReplicantStorage,
	ReplicantNotFound,
} from "./replicant-storage.ts";

export const createStorageStub = () => {
	const read = vi.fn<ReplicantStorage["read"]>(
		(namespace, name) => new ReplicantNotFound({ namespace, name }),
	);
	const write = vi.fn<ReplicantStorage["write"]>(() => Effect.void);
	const stub = {
		read,
		write,
	} satisfies ReplicantStorage;
	const reset = () => {
		for (const mock of [read, write]) {
			mock.mockReset();
		}
	};
	return { stub, reset };
};
