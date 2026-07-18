import {
	implementExtendedNamespace,
	implementNamespace,
	loadNodeCG,
} from "@nodecg/server";

import { makeFakeAuthProvider } from "./fake-auth-provider.ts";
import {
	baseManifest,
	crossManifest,
	extendedManifest,
	fixtureManifest,
} from "./fixture-replicant.ts";

const fixture = implementNamespace(fixtureManifest, {
	seedReplicant: {
		count: () => 0,
		label: () => "hello",
		secret: () => "classified",
		producerOnly: () => "producers-only",
		membersOnly: () => "members-only",
	},
	implementComputed: {
		doubledCount: (sources: { count: number }) => sources.count * 2,
		summary: (sources: { count: number; label: string }) =>
			sources.count > 0 ? `${sources.label} x${sources.count}` : "idle",
	},
	implementRpc: {
		echo: (request: string) => request.toUpperCase(),
		bump: (request: number, ctx) => {
			ctx.replicant.count.update((count) => count + request);
			return ctx.replicant.count.get();
		},
	},
	frontend: {
		dir: [import.meta.resolve("./fixture-frontend")],
	},
});

const baseImplemented = implementNamespace(baseManifest, {
	seedReplicant: { score: () => 0 },
	frontend: {
		dir: [import.meta.resolve("./fixture-frontend-spa")],
		spa: true,
	},
});
const extended = implementExtendedNamespace(extendedManifest, baseImplemented, {
	seedReplicant: { bonus: () => 0 },
	implementComputed: {
		total: (sources) => sources.score + sources.bonus,
	},
	frontend: {
		dir: [import.meta.resolve("./fixture-frontend-extra")],
	},
});

const cross = implementNamespace(crossManifest, {
	seedReplicant: { factor: () => 2 },
	implementComputed: {
		scaledScore: (sources, ctx) =>
			sources.factor * ctx.use(extended).replicant.score.get(),
	},
	implementRpc: {
		addScore: (points, ctx) => {
			ctx.use(extended).replicant.score.update((score) => score + points);
			return ctx.use(extended).replicant.score.get();
		},
	},
});

process.env["SUPERADMINS"] = "dev:root";

const nodecg = await loadNodeCG({
	// `cross` listed before the namespace its computed reads, so build order must not matter
	namespaces: [cross, fixture, extended],
	authProviders: [
		makeFakeAuthProvider("dev", [{ id: "alice", displayName: "Alice" }]),
	],
	superadmins: [{ issuer: "dev", subject: "root" }],
	onReady: () => {
		if (typeof process.send === "undefined") {
			throw new Error("start-server.ts must be spawned with an IPC channel");
		}
		process.send("ready");
	},
});

nodecg.start();
