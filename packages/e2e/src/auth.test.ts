import { IdentitySchema } from "@nodecg/internal";
import { Schema } from "effect";
import { describe, expect, test } from "vitest";

const MeSchema = Schema.Struct({ identity: IdentitySchema });
const decodeMe = Schema.decodeUnknownSync(MeSchema);

const fetchMe = async (init?: RequestInit) =>
	decodeMe(await (await fetch("/api/me", init)).json());

describe("anonymous identity", () => {
	test("a request without a session resolves to the public identity", async () => {
		expect((await fetchMe()).identity).toEqual({ _tag: "public" });
	});
});

describe("browser login", () => {
	test("logging in establishes a session, logout tears it down", async () => {
		await fetch("/api/authentication/login/dev?as=alice", { method: "POST" });

		expect((await fetchMe()).identity).toEqual({
			_tag: "human",
			issuer: "dev",
			subject: "alice",
			displayName: "Alice",
		});

		await fetch("/api/authentication/logout", { method: "POST" });
		expect((await fetchMe()).identity).toEqual({ _tag: "public" });
	});
});
