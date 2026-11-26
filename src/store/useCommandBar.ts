import { create } from "zustand";

/**
 * Ephemeral UI state for the global ⌘K command bar. Deliberately NOT persisted
 * and kept out of the big `useAppStore` so the palette can open from anywhere
 * (TopBar search, a button, the keyboard) without re-rendering data consumers
 * or touching the persisted store's version.
 */
interface CommandBarState {
  /** Whether the command palette overlay is open. */
  open: boolean;
  /**
   * The ticker whose workspace the user is currently viewing, if any. Bare
   * `/action` commands (`/chart`, `/news`, …) act on THIS ticker - the
   * Bloomberg "loaded security" convention. Set by the workspace route,
   * cleared when leaving it.
   */
  contextTicker: string | null;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setContextTicker: (ticker: string | null) => void;
}

export const useCommandBar = create<CommandBarState>((set) => ({
  open: false,
  contextTicker: null,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  setContextTicker: (contextTicker) =>
    set((s) => (s.contextTicker === contextTicker ? s : { contextTicker })),
}));
