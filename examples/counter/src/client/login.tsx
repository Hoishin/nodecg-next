import { useEffect, useState } from "react";

interface HumanAccount {
	readonly issuer: string;
	readonly subject: string;
	readonly displayName: string;
}

type Identity =
	| { readonly _tag: "anonymous" }
	| { readonly _tag: "human"; readonly account: HumanAccount }
	| {
			readonly _tag: "machine";
			readonly id: string;
			readonly displayName: string;
	  };

type State =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready"; readonly identity: Identity };

// TODO: use effect platform http client
const fetchIdentity = async (): Promise<Identity> => {
	const response = await fetch("/api/me");
	if (!response.ok) {
		throw new Error(`GET /api/me responded ${response.status}`);
	}
	const body: { identity: Identity } = await response.json();
	return body.identity;
};

const popupName = "nodecg-login";

export function Login() {
	const [state, setState] = useState<State>({ status: "loading" });

	const ready = (identity: Identity) => {
		setState({ status: "ready", identity });
	};

	useEffect(() => {
		void fetchIdentity().then(ready, (error: unknown) =>
			setState({
				status: "error",
				message: error instanceof Error ? error.message : String(error),
			}),
		);
	}, []);

	const logIn = () => {
		const popup = window.open(
			"about:blank",
			popupName,
			"popup,width=520,height=700",
		);

		// TODO: use postMessage
		let ticks = 0;
		const timer = window.setInterval(() => {
			ticks += 1;
			void fetchIdentity()
				.catch(() => undefined)
				.then((identity) => {
					if (identity?._tag === "human") {
						window.clearInterval(timer);
						popup?.close();
						ready(identity);
					} else if (popup?.closed === true || ticks >= 120) {
						window.clearInterval(timer);
					}
				});
		}, 1000);
	};

	const logOut = () => {
		void fetch("/api/authentication/logout", { method: "POST" }).then(() => {
			setState({ status: "ready", identity: { _tag: "anonymous" } });
		});
	};

	if (state.status === "loading") {
		return <p>Checking session…</p>;
	}

	if (state.status === "error") {
		return <p>Could not load session: {state.message}</p>;
	}

	if (state.identity._tag === "human") {
		return (
			<p>
				Logged in as <strong>{state.identity.account.displayName}</strong>{" "}
				<button type="button" onClick={logOut}>
					Log out
				</button>
			</p>
		);
	}

	return (
		<form
			method="post"
			action="/api/authentication/login/local"
			target={popupName}
			onSubmit={logIn}
		>
			Not logged in. <button type="submit">Log in with local OIDC</button>
		</form>
	);
}
