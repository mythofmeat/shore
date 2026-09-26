import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing Shore application root");
createRoot(root).render(<App />);
