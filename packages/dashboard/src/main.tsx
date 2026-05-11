import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
	Outlet,
	RouterProvider,
	Link,
	createRouter,
	createRoute,
	createRootRoute,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { Effect } from "effect";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import { apiClient } from "./api.ts";
import { sendMessage, useWsState } from "./ws.ts";

const queryClient = new QueryClient();

const rootRoute = createRootRoute({
	component: () => (
		<>
			<div className="p-2 flex gap-2">
				<Link to="/" className="[&.active]:font-bold">
					Home
				</Link>{" "}
				<Link to="/about" className="[&.active]:font-bold">
					About
				</Link>
			</div>
			<hr />
			<Outlet />
			<TanStackRouterDevtools />
		</>
	),
});

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/",
	component: function Index() {
		const { data: ping } = useQuery({
			queryKey: ["ping"],
			queryFn: async () => Effect.runPromise((await apiClient).Api.ping()),
		});
		const wsState = useWsState();

		return (
			<div className="p-2">
				<h3>Welcome Home!</h3>
				<p>GET /api/ping → {ping ?? "…"}</p>
				<p>WS /ws → {wsState}</p>
				<button onClick={() => sendMessage({ _tag: "ping" })} disabled={wsState !== "open"}>
					send ping
				</button>
			</div>
		);
	},
});

const aboutRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: "/about",
	component: function About() {
		return <div className="p-2">Hello from About!</div>;
	},
});

const routeTree = rootRoute.addChildren([indexRoute, aboutRoute]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

const rootElement = document.getElementById("app")!;
if (!rootElement.innerHTML) {
	const root = ReactDOM.createRoot(rootElement);
	root.render(
		<StrictMode>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</StrictMode>,
	);
}
