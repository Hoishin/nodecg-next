import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { StateValidationError } from "@nodecg/core";
import { Effect, Layer } from "effect";
import { describe, expect, test, vi } from "vitest";

import { stateMetadataKey, type LoadedState } from "../load-state.ts";
import { type StateField, stateFieldInternal } from "../models/state-field.ts";
import {
	StateGetFailed,
	StateNotFound,
	StateSaveFailed,
} from "../services/state-storage/state-storage.ts";
import { buildNodecgApi } from "./http-api.ts";

type Internal = StateField<unknown>[typeof stateFieldInternal];

function stubField(
	internal: Pick<Internal, "get" | "setEncoded">,
): StateField<unknown> {
	const unused = vi.fn();
	return {
		get: unused,
		set: unused,
		update: unused,
		validate: unused,
		[stateFieldInternal]: {
			get: internal.get,
			set: unused,
			update: unused,
			validate: unused,
			setEncoded: internal.setEncoded,
		},
	};
}

function loadedState(
	namespace: string,
	fields: Record<string, StateField<unknown>>,
): LoadedState {
	return { ...fields, [stateMetadataKey]: { namespace } };
}

function webHandler(states: ReadonlyArray<LoadedState>) {
	const { handler } = HttpApiBuilder.toWebHandler(
		Layer.mergeAll(buildNodecgApi({ states }), HttpServer.layerContext),
	);
	return handler;
}

const getUrl = "http://x/api/namespaces/root/state/count";

describe("ping", () => {
	test("returns pong", async () => {
		const handler = webHandler([]);
		const res = await handler(new Request("http://x/api/ping"));
		expect(res.status).toBe(200);
		expect(await res.json()).toBe("pong");
	});
});

describe("get", () => {
	test("returns the stored value", async () => {
		const handler = webHandler([
			loadedState("root", {
				count: stubField({
					get: () => Effect.succeed(42),
					setEncoded: () => Effect.void,
				}),
			}),
		]);
		const res = await handler(new Request(getUrl));
		expect(res.status).toBe(200);
		expect(await res.json()).toBe(42);
	});

	test("404 when the namespace/name is not registered", async () => {
		const handler = webHandler([]);
		const res = await handler(new Request(getUrl));
		expect(res.status).toBe(404);
	});

	test("404 when the field reports StateNotFound", async () => {
		const handler = webHandler([
			loadedState("root", {
				count: stubField({
					get: () =>
						Effect.fail(
							new StateNotFound({ namespace: "root", name: "count" }),
						),
					setEncoded: () => Effect.void,
				}),
			}),
		]);
		const res = await handler(new Request(getUrl));
		expect(res.status).toBe(404);
	});

	test("500 when the field reports StateGetFailed", async () => {
		const handler = webHandler([
			loadedState("root", {
				count: stubField({
					get: () =>
						Effect.fail(
							new StateGetFailed({
								namespace: "root",
								name: "count",
								cause: new Error("boom"),
							}),
						),
					setEncoded: () => Effect.void,
				}),
			}),
		]);
		const res = await handler(new Request(getUrl));
		expect(res.status).toBe(500);
	});

	test("500 when the field reports StateValidationError", async () => {
		const handler = webHandler([
			loadedState("root", {
				count: stubField({
					get: () =>
						Effect.fail(
							new StateValidationError({
								name: "count",
								cause: new Error("boom"),
							}),
						),
					setEncoded: () => Effect.void,
				}),
			}),
		]);
		const res = await handler(new Request(getUrl));
		expect(res.status).toBe(500);
	});
});

describe("update", () => {
	function putRequest(value: unknown) {
		return new Request(getUrl, {
			method: "PUT",
			body: JSON.stringify(value),
			headers: { "content-type": "application/json" },
		});
	}

	test("stores the decoded payload and returns 204", async () => {
		const setEncoded = vi.fn((_value: unknown) => Effect.void);
		const handler = webHandler([
			loadedState("root", {
				count: stubField({ get: () => Effect.succeed(0), setEncoded }),
			}),
		]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(204);
		expect(setEncoded).toHaveBeenCalledWith(7);
	});

	test("404 when the namespace/name is not registered", async () => {
		const handler = webHandler([]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(404);
	});

	test("400 when the field reports StateValidationError", async () => {
		const handler = webHandler([
			loadedState("root", {
				count: stubField({
					get: () => Effect.succeed(0),
					setEncoded: () =>
						Effect.fail(
							new StateValidationError({
								name: "count",
								cause: new Error("boom"),
							}),
						),
				}),
			}),
		]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(400);
	});

	test("404 when the field reports StateNotFound", async () => {
		const handler = webHandler([
			loadedState("root", {
				count: stubField({
					get: () => Effect.succeed(0),
					setEncoded: () =>
						Effect.fail(
							new StateNotFound({ namespace: "root", name: "count" }),
						),
				}),
			}),
		]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(404);
	});

	test("500 when the field reports StateSaveFailed", async () => {
		const handler = webHandler([
			loadedState("root", {
				count: stubField({
					get: () => Effect.succeed(0),
					setEncoded: () =>
						Effect.fail(
							new StateSaveFailed({
								namespace: "root",
								name: "count",
								cause: new Error("boom"),
							}),
						),
				}),
			}),
		]);
		const res = await handler(putRequest(7));
		expect(res.status).toBe(500);
	});
});
