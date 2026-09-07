import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "src/_exports.ts",
		occ: "src/occ/_exports.ts",
		utils: "src/utils/_exports.ts",
		"test-utils": "src/test-utils/_exports.ts",
	},
});
