import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Routes, Route } from "react-router-dom";

/**
 * The shell must distinguish "pending" (render the route / its skeleton) from "genuinely
 * unconfigured" (show the gate).
 */
vi.mock("../Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../TopBar", () => ({ TopBar: () => null }));
vi.mock("../ToastHost", () => ({ ToastHost: () => null }));
vi.mock("../ResearchNarrator", () => ({ ResearchNarrator: () => null }));
vi.mock("@/components/terminal/CommandBar", () => ({ CommandBar: () => null }));
vi.mock("@/hooks/useSampleDataMode", () => ({ useSampleDataMode: () => false }));

const providers = vi.hoisted(() => ({ pending: false, configured: false }));
vi.mock("@/data/providers", () => ({
  isProviderResolutionPending: () => providers.pending,
  isDataSourceConfigured: () => providers.configured,
}));

import { AppShell } from "../AppShell";

const GATE = "enabled in this build";

function markup(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/today"]}>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="today" element={<div>OUTLET_CONTENT</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AppShell data-source gate", () => {
  it("does NOT show the 'coming soon' gate while controls are loading (pending)", () => {
    providers.pending = true;
    providers.configured = false; // false during pending - must NOT gate
    const html = markup();
    expect(html).not.toContain(GATE);
    expect(html).toContain("OUTLET_CONTENT");
  });

  it("shows the gate ONLY when genuinely unconfigured (not pending, no source)", () => {
    providers.pending = false;
    providers.configured = false;
    const html = markup();
    expect(html).toContain(GATE);
    expect(html).not.toContain("OUTLET_CONTENT");
  });

  it("renders the route normally once a source is configured", () => {
    providers.pending = false;
    providers.configured = true;
    const html = markup();
    expect(html).not.toContain(GATE);
    expect(html).toContain("OUTLET_CONTENT");
  });
});
