import { createRoot } from "react-dom/client";
import { App } from "./App";
import { MotionUIThemeProvider } from "@/components/motion-ui/ui-theme";
import motionTheme from "@/../motion.theme";
import { claimAccessKey } from "@/lib/api";
import "./index.css";

/**
 * Pair before the first render, then get the key out of the address bar.
 *
 * The shared link carries `?k=…`; awaiting the trade means the cookie exists
 * before `App` mounts and issues its first request, so nobody sees a 401 that
 * was only a race. The key is then dropped from the URL — it has served its one
 * purpose, and leaving it there would keep it in the history, in a bookmark and
 * in any screenshot of the address bar.
 */
async function pairFromUrl(): Promise<void> {
	const url = new URL(window.location.href);
	const key = url.searchParams.get("k");
	if (!key) return;

	try {
		await claimAccessKey(key);
	} catch {
		// A refused key must not leave a blank page: render anyway and let the
		// ordinary 401 reach the user where they can read it.
	}

	url.searchParams.delete("k");
	window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

void pairFromUrl().then(() => {
	createRoot(document.getElementById("root")!).render(
		<MotionUIThemeProvider theme={motionTheme}>
			<App />
		</MotionUIThemeProvider>,
	);
});
