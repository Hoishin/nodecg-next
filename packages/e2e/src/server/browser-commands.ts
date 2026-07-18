import type { BrowserCommand } from "vitest/node";

export const closeLoginPopup: BrowserCommand<[]> = async (ctx) => {
	const popup =
		ctx.context.pages().find((page) => page !== ctx.page) ??
		(await ctx.context.waitForEvent("page"));
	await popup.close();
};

export const countPages: BrowserCommand<[]> = (ctx) =>
	ctx.context.pages().length;

declare module "vitest/internal/browser" {
	interface BrowserCommands {
		closeLoginPopup: () => ReturnType<typeof closeLoginPopup>;
		countPages: () => ReturnType<typeof countPages>;
	}
}
