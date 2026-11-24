import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { MiniTimer } from "./components/MiniTimer";
import "./index.css";

const isMiniWindow =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("window") === "mini";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isMiniWindow ? <MiniTimer /> : <App />}</StrictMode>,
);
