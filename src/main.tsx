import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { MiniTimer } from "./components/MiniTimer";
import "./index.css";

if (typeof document !== "undefined") {
  // Prevent native browser ghost-dragging of UI chrome/icons when grabbing the window surface.
  document.addEventListener("dragstart", (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest('input, textarea, [contenteditable="true"], [draggable="true"]'))
    ) {
      return;
    }
    event.preventDefault();
  });

  // Prevent middle-click autoscroll mode from panning/shaking the desktop viewport.
  document.addEventListener("mousedown", (event) => {
    if (event.button === 1) {
      event.preventDefault();
    }
  });
}

const isMiniWindow =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("window") === "mini";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{isMiniWindow ? <MiniTimer /> : <App />}</StrictMode>,
);
