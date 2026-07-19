declare module "vitest/internal/browser" {
	interface BrowserCommands {
		closeLoginPopup: () => Promise<void>;
		countPages: () => Promise<number>;
	}
}
