/**
 * Sample directory of public accounts / creators - "Channels" you can Follow.
 *
 * Following a channel is a one-way, local action (like following a public
 * account), so it works fully with mock data and needs no backend. The set of
 * channels the user follows lives in the store (`following: string[]` of
 * handles); a channel's shares only surface once it's followed.
 *
 * NOTE: these are public accounts, NOT personal friends. Mutual friends need
 * real accounts + a backend - see docs/friends-and-accounts.md (roadmap).
 */

export type ChannelCategory = "Quant" | "Value" | "Policy" | "Options";

export interface Channel {
  handle: string;
  name: string;
  /** Two-letter avatar initials. */
  initials: string;
  accent: string;
  category: ChannelCategory;
  /** One-line "why follow them" blurb shown in the Discover list. */
  bio: string;
}

export interface ChannelShare {
  id: string;
  handle: string;
  ticker: string;
  note: string;
  sharedAt: string;
}

/** Discoverable public channels - not followed until the user follows them. */
export const CHANNELS: Channel[] = [
  {
    handle: "@quantkate",
    name: "Kate Nguyen",
    initials: "KN",
    accent: "#d9a04a",
    category: "Quant",
    bio: "Small-cap momentum & relative-strength breakouts.",
  },
  {
    handle: "@deepvalue",
    name: "Marcus Hale",
    initials: "MH",
    accent: "#3cb88a",
    category: "Value",
    bio: "Cash-flow-first value, durable demand, sane multiples.",
  },
  {
    handle: "@capitolwatch",
    name: "Capitol Watch",
    initials: "CW",
    accent: "#6741a8",
    category: "Policy",
    bio: "Names showing up in political-trade & policy flow.",
  },
  {
    handle: "@volsurfer",
    name: "Dana Reyes",
    initials: "DR",
    accent: "#3f5fc9",
    category: "Options",
    bio: "Options & volatility setups into catalysts.",
  },
];

/** Look up a channel by its handle. */
export const channelByHandle = (handle: string): Channel | undefined =>
  CHANNELS.find((c) => c.handle === handle);

const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

/**
 * Sample posts each channel has published. Only shown once you follow them.
 *
 * Tickers reference names in the sample universe (see src/data/mockSignals.ts)
 * so a followed channel's posts resolve to real scored cards in the feed.
 */
export const CHANNEL_SHARES: ChannelShare[] = [
  {
    id: "share_1",
    handle: "@quantkate",
    ticker: "CHIP",
    note: "Breaking out of a 3-month base into the summit. Relative-strength leader — momentum book add.",
    sharedAt: iso(2),
  },
  {
    id: "share_2",
    handle: "@volsurfer",
    ticker: "ZMEDX",
    note: "IV is rich into the data readout — sizing small, but the setup is clean.",
    sharedAt: iso(5),
  },
  {
    id: "share_3",
    handle: "@capitolwatch",
    ticker: "ORBT",
    note: "Showed up on a disclosure feed this morning. Watching, not chasing.",
    sharedAt: iso(7),
  },
  {
    id: "share_4",
    handle: "@deepvalue",
    ticker: "ZBREW",
    note: "Best risk/reward in consumer staples if you actually care about free cash flow.",
    sharedAt: iso(11),
  },
  {
    id: "share_5",
    handle: "@quantkate",
    ticker: "ZGIGA",
    note: "Design-win rumor + relative strength. Adding on dips.",
    sharedAt: iso(20),
  },
  {
    id: "share_6",
    handle: "@volsurfer",
    ticker: "ZVOLT",
    note: "Catalyst-driven vol setup into the print. Defined-risk calls here.",
    sharedAt: iso(28),
  },
];
