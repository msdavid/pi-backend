/**
 * Console entry point: applies the persisted theme, then mounts the app —
 * TanStack Query provider around the TanStack Router provider.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createQueryClient } from "./app/query.js";
import { router } from "./app/router.js";
import { applyTheme, getStoredTheme } from "./lib/theme.js";
import "./styles/tokens.css";
import "./styles/global.css";

applyTheme(getStoredTheme());

const queryClient = createQueryClient();

// The #root element is static markup in index.html; it always exists.
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("web-console: #root element missing");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
