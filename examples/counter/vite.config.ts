import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	base: "./",
	plugins: [react()],
	build: {
		rollupOptions: {
			input: {
				index: "index.html",
				dashboard: "dashboard.html",
				graphics: "graphics.html",
			},
		},
	},
});
