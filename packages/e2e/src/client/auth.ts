import { authSession } from "@nodecg/browser";
import { loadAuthClient } from "@nodecg/client";

const client = loadAuthClient();
const session = authSession(client);

export const login = async (subject: string) => {
	await client.logout();
	const providers = await client.providers();
	const dev = providers.find((provider) => provider.name === "dev");
	if (typeof dev === "undefined") {
		throw new Error("dev provider is not registered");
	}
	return session.popupLogin({ ...dev, url: `${dev.url}?as=${subject}` });
};

export const logout = () => client.logout();

export const me = () => client.me();

export const grantRole = (subject: string, role: string) =>
	client.grantRole({ issuer: "dev", subject, role });

export const revokeRole = (subject: string, role: string) =>
	client.revokeRole({ issuer: "dev", subject, role });

export const grantAsAdmin = async (subject: string, role: string) => {
	await login("root");
	await grantRole(subject, role);
};

export const revokeAsAdmin = async (subject: string, role: string) => {
	await login("root");
	await revokeRole(subject, role);
};
