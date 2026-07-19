import { authSession } from "@nodecg/browser";
import { loadAuthClient } from "@nodecg/client";

export const makeAuthHelpers = (baseUrl: string) => {
	const client = loadAuthClient(baseUrl);
	const session = authSession(client);

	const login = async (subject: string) => {
		await client.logout();
		const providers = await client.providers();
		const dev = providers.find((provider) => provider.name === "dev");
		if (typeof dev === "undefined") {
			throw new Error("dev provider is not registered");
		}
		return session.popupLogin({ ...dev, url: `${dev.url}?as=${subject}` });
	};

	const logout = () => client.logout();
	const me = () => client.me();

	const grantRole = (subject: string, role: string) =>
		client.grantRole({ issuer: "dev", subject, role });

	const revokeRole = (subject: string, role: string) =>
		client.revokeRole({ issuer: "dev", subject, role });

	const grantAsAdmin = async (subject: string, role: string) => {
		await login("root");
		await grantRole(subject, role);
	};

	const revokeAsAdmin = async (subject: string, role: string) => {
		await login("root");
		await revokeRole(subject, role);
	};

	return {
		client,
		session,
		login,
		logout,
		me,
		grantRole,
		revokeRole,
		grantAsAdmin,
		revokeAsAdmin,
	};
};
