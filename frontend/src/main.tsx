import { createRoot } from "react-dom/client";
import { App } from "./App";
import { MotionUIThemeProvider } from "@/components/motion-ui/ui-theme";
import motionTheme from "@/../motion.theme";
import "./index.css";

createRoot(document.getElementById("root")!).render(
	<MotionUIThemeProvider theme={motionTheme}>
		<App />
	</MotionUIThemeProvider>,
);
