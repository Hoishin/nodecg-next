import { expect, test } from "vitest";

test("runs in a real browser", () => {
	expect(typeof window).toBe("object");
	expect(typeof document).toBe("object");
});
