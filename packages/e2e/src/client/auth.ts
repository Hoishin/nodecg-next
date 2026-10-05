import { authSession } from "@nodecg-next/browser";
import { loadAuthClient, type RoleAssignment } from "@nodecg-next/client";

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

	const findAccountId = async (subject: string) => {
		const { users } = await client.listUsers();
		const user = users.find(({ authentications }) =>
			authentications.some(
				(authentication) =>
					authentication.issuer === "dev" && authentication.subject === subject,
			),
		);
		if (typeof user === "undefined") {
			throw new Error(`"${subject}" has no account`);
		}
		return user.accountId;
	};

	const createAccount = async (subject: string) => {
		await login(subject);
		await login("root");
		const accountId = await findAccountId(subject);
		await logout();
		return accountId;
	};

	const grantRole = (accountId: string, role: RoleAssignment["role"]) =>
		client.grantRole({ accountId, role });

	const revokeRole = (accountId: string, role: RoleAssignment["role"]) =>
		client.revokeRole({ accountId, role });

	const grantAsAdmin = async (
		accountId: string,
		role: RoleAssignment["role"],
	) => {
		await login("root");
		await grantRole(accountId, role);
	};

	const revokeAsAdmin = async (
		accountId: string,
		role: RoleAssignment["role"],
	) => {
		await login("root");
		await revokeRole(accountId, role);
	};

	return {
		client,
		session,
		login,
		logout,
		me,
		createAccount,
		grantRole,
		revokeRole,
		grantAsAdmin,
		revokeAsAdmin,
	};
};
