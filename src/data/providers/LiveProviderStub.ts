import type { CompanyData } from "@/types";
import type { DataProvider } from "./types";

/**
 * Template for a REAL market-data provider.
 *
 * This is intentionally a stub: it documents exactly where a live integration
 * plugs in without shipping any keys or network calls in the MVP. Each real
 * provider (Finnhub, Alpha Vantage, Polygon, FMP, …) would subclass this shape.
 *
 * Wiring checklist (see docs/data-sources.md):
 *   1. Read the API key from `import.meta.env.VITE_*` - NEVER hardcode it.
 *   2. Fan out to fundamentals / quote / news / social endpoints.
 *   3. Normalize each response into the `CompanyData` shape.
 *   4. For secret-grade keys, proxy calls through a backend/edge function
 *      instead of calling the vendor directly from the desktop client.
 */
export class LiveProviderStub implements DataProvider {
  readonly id: string;
  readonly name: string;
  readonly isLive = false; // flip to true once fetchUniverse() is implemented

  private readonly apiKey: string | undefined;

  constructor(id: string, name: string, apiKeyEnv: string) {
    this.id = id;
    this.name = name;
    // Vite exposes only VITE_-prefixed vars; undefined when not configured.
    this.apiKey = (import.meta.env as Record<string, string | undefined>)[apiKeyEnv];
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async fetchUniverse(): Promise<CompanyData[]> {
    throw new Error(
      `${this.name} is not wired yet. Implement fetchUniverse() and map vendor ` +
        `responses into CompanyData. See docs/data-sources.md.`,
    );
  }
}
