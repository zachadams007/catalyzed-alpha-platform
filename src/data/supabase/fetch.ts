/**
 * Route Supabase API calls through Tauri's HTTP plugin in the desktop app.
 * The default browser fetch often fails there with "Failed to fetch".
 */
export const supabaseFetch: typeof fetch = async (input, init) => {
  const { isTauri } = await import("@tauri-apps/api/core");
  if (isTauri()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(input, init);
  }
  return fetch(input, init);
};
