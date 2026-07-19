import { Cookies } from "@effect/platform";
import { baseUrlCookieName, baseUrlGlobalName } from "@nodecg/internal";

const injectedBase = (): string | undefined => {
	const value: unknown = Reflect.get(globalThis, baseUrlGlobalName);
	return typeof value === "string" ? value : undefined;
};

const cookieBase = (): string | undefined =>
	Cookies.parseHeader(document.cookie)[baseUrlCookieName];

export const nodecgBase = (): string | undefined =>
	injectedBase() ?? cookieBase();
