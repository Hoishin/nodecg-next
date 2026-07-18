import { batch, signal } from "@preact/signals-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { derive, type FieldSource, fieldSource } from "./derive.ts";
import { Failure, type Loadable, Pending, Ready } from "./loadable.ts";

const source = <T>(initial: Loadable<T>) => {
	const s = signal(initial);
	const handle: FieldSource<T> = { [fieldSource]: s };
	return { s, handle };
};

describe("derive", () => {
	it("computes over ready sources and recomputes on change", async () => {
		const left = source(Ready({ value: 3 }));
		const right = source(Ready({ value: 1 }));
		const delta = derive((get) => get(left.handle) - get(right.handle));

		expect(await delta.get()).toBe(2);

		const seen: number[] = [];
		const unsubscribe = delta.subscribe((value) => {
			seen.push(value);
		});
		onTestFinished(unsubscribe);
		left.s.value = Ready({ value: 10 });
		expect(seen).toEqual([2, 9]);
	});

	it("a batched multi-source write recomputes once, glitch-free", () => {
		const a = source(Ready({ value: 1 }));
		const b = source(Ready({ value: 2 }));
		let evaluations = 0;
		const sum = derive((get) => {
			evaluations += 1;
			return get(a.handle) + get(b.handle);
		});

		const seen: number[] = [];
		const unsubscribe = sum.subscribe((value) => {
			seen.push(value);
		});
		onTestFinished(unsubscribe);
		const before = evaluations;
		batch(() => {
			a.s.value = Ready({ value: 10 });
			b.s.value = Ready({ value: 20 });
		});
		expect(evaluations - before).toBe(1);
		expect(seen).toEqual([3, 30]);
	});

	it("suspends on a pending source and resumes when it arrives", async () => {
		const left = source<number>(Pending);
		const right = source<number>(Pending);
		const winning = derive((get) => get(left.handle) > get(right.handle));

		const seen: boolean[] = [];
		const unsubscribe = winning.subscribe((value) => {
			seen.push(value);
		});
		onTestFinished(unsubscribe);
		expect(seen).toEqual([]);

		left.s.value = Ready({ value: 3 });
		expect(seen).toEqual([]); // still pending on right
		right.s.value = Ready({ value: 1 });
		expect(seen).toEqual([true]);

		expect(await winning.get()).toBe(true);
	});

	it("rejects get() and fires onError when a source failed", async () => {
		const boom = new Error("rejected");
		const failed = source<number>(Failure({ error: boom }));
		const doubled = derive((get) => get(failed.handle) * 2);

		await expect(doubled.get()).rejects.toBe(boom);

		const onError = vi.fn();
		const unsubscribe = doubled.subscribe(() => {}, onError);
		onTestFinished(unsubscribe);
		expect(onError).toHaveBeenCalledWith(boom);
	});

	it("derives over another derive and dedupes an unchanged intermediate", () => {
		const left = source(Ready({ value: 3 }));
		const right = source(Ready({ value: 1 }));
		const delta = derive((get) => get(left.handle) - get(right.handle));
		let evaluations = 0;
		const winning = derive((get) => {
			evaluations += 1;
			return get(delta) > 0;
		});

		const unsubscribe = winning.subscribe(() => {});
		onTestFinished(unsubscribe);
		const before = evaluations;
		batch(() => {
			left.s.value = Ready({ value: 4 });
			right.s.value = Ready({ value: 2 }); // delta still 2
		});
		expect(evaluations - before).toBe(0);
	});

	it("never evaluates while nothing subscribes or reads", () => {
		const src = source(Ready({ value: 1 }));
		let evaluations = 0;
		const doubled = derive((get) => {
			evaluations += 1;
			return get(src.handle) * 2;
		});
		src.s.value = Ready({ value: 2 });
		src.s.value = Ready({ value: 3 });
		expect(evaluations).toBe(0);
		void doubled;
	});

	it("dedupes object values through a custom equals", () => {
		const src = source(Ready({ value: 1 }));
		const boxed = derive((get) => ({ n: get(src.handle) }), {
			equals: (a, b) => a.n === b.n,
		});

		const seen: { n: number }[] = [];
		const unsubscribe = boxed.subscribe((value) => {
			seen.push(value);
		});
		onTestFinished(unsubscribe);
		expect(seen).toHaveLength(1);

		src.s.value = Ready({ value: 1 }); // same n, fresh object → deduped
		expect(seen).toHaveLength(1);

		src.s.value = Ready({ value: 2 });
		expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
	});
});
