import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Geist, Geist Mono and Instrument Serif, served by the app itself: the page asks no third party for anything.
import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-sans/latin-600.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import App from "./App";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/landing.css";
import "./styles/landing-parts.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
