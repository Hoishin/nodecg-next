export const login = (subject: string) =>
	fetch(`/api/internal/authentication/login/dev?as=${subject}`, {
		method: "POST",
	});

export const logout = () =>
	fetch("/api/internal/authentication/logout", { method: "POST" });

export const assignRole = (
	action: "grant" | "revoke",
	subject: string,
	role: string,
) =>
	fetch(`/api/internal/roles/${action}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ issuer: "dev", subject, role }),
	});

export const grantAsAdmin = async (subject: string, role: string) => {
	await login("root");
	await assignRole("grant", subject, role);
};

export const revokeAsAdmin = async (subject: string, role: string) => {
	await login("root");
	await assignRole("revoke", subject, role);
};
