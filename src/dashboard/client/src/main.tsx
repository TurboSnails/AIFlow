import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("root element not found");

createRoot(root).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
