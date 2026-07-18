import { authSession } from "@nodecg/browser";
import { type LoginProvider } from "@nodecg/client";
import { Suspense, use, useState, useSyncExternalStore } from "react";

const session = authSession();
const providersPromise = session.client.providers();

const useIdentity = () =>
	useSyncExternalStore(session.identity.subscribe, session.identity.get);

function LoginButtons({ onError }: { onError: (message: string) => void }) {
	const providers = use(providersPromise);
	const logIn = (provider: LoginProvider) => {
		void session.popupLogin(provider).catch((cause: unknown) => {
			onError(
				cause instanceof Error && cause.message.includes("blocked")
					? "Popups are blocked — allow them for this page and try again"
					: String(cause),
			);
		});
	};
	return (
		<>
			{providers.map((provider) => (
				<button
					key={provider.name}
					type="button"
					onClick={() => logIn(provider)}
				>
					Log in with {provider.name}
				</button>
			))}
		</>
	);
}

export function Login() {
	const identity = useIdentity();
	const [error, setError] = useState<string | undefined>(undefined);

	if (typeof identity === "undefined") {
		return <p>Checking session…</p>;
	}

	if (identity._tag === "human") {
		return (
			<p>
				Logged in as <strong>{identity.account.displayName}</strong>{" "}
				<button type="button" onClick={() => void session.logout()}>
					Log out
				</button>
			</p>
		);
	}

	return (
		<div>
			<p>
				Not logged in.{" "}
				<Suspense fallback={null}>
					<LoginButtons onError={setError} />
				</Suspense>
			</p>
			{typeof error === "undefined" ? null : <p>{error}</p>}
		</div>
	);
}
