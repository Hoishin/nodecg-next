import {
	implementExtendedNamespace,
	loadNodeCG,
	makeOidcProvider,
} from "@nodecg/server";
import { OAuth2Server } from "oauth2-mock-server";

import { extendedCounterManifest } from "../shared/manifest.ts";
import { counter, settings } from "./library/server.ts";

const extendedCounter = implementExtendedNamespace(
	extendedCounterManifest,
	counter,
	{
		seedReplicant: { step: () => 1 },
		implementComputed: {
			parity: (sources) => (sources.count % 2 === 0 ? "even" : "odd"),
		},
	},
	{
		frontend: {
			dir: import.meta.resolve("../../dist"),
			vite: { root: import.meta.resolve("../..") },
		},
	},
);

const idp = new OAuth2Server();
await idp.issuer.keys.generate("RS256");
await idp.start(0, "localhost");
const issuer = idp.issuer.url;
if (typeof issuer === "undefined") {
	throw new Error("local OIDC server did not start");
}

const localProvider = await makeOidcProvider({
	name: "local",
	issuer,
	clientId: "example-client",
	clientSecret: "example-secret",
	allowInsecure: true,
});

loadNodeCG({
	namespaces: [extendedCounter, settings],
	authProviders: [localProvider],
	dev: process.env["NODE_ENV"] !== "production",
	superadmins: [{ issuer, subject: "johndoe" }],
});
