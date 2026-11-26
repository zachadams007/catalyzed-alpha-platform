/**
 * Niche discovery "missions" for the AI research agent.
 *
 * Each mission is a research narrative the hosted Gemini agent expands into a
 * handful of REAL, currently-listed U.S. tickers via live web search. The point
 * is to surface specialized, under-followed names - the opposite of a fixed
 * mega-cap list - and to keep the main feed fresh by rotating through different
 * themes on each refresh.
 *
 * Discovery/research only: the agent never returns buy/sell advice (see the
 * edge function system prompt). Tickers are validated by live hydration before
 * they ever reach scoring.
 */

export interface DiscoveryMission {
  id: string;
  /** Short label for logs / provenance. */
  label: string;
  /** The narrative sent to the agent's `discover` task. */
  narrative: string;
  /** Theme hints passed alongside the narrative. */
  themes: string[];
}

export const DISCOVERY_MISSIONS: DiscoveryMission[] = [
  {
    id: "ai-infra-picks",
    label: "AI infrastructure under-the-radar",
    narrative:
      "Find under-followed small- and mid-cap U.S. companies that quietly power the AI buildout — data-center power and cooling, optical networking, niche memory or interconnect chips, and AI hardware suppliers — that most retail investors have never heard of. Avoid the obvious mega-caps.",
    themes: ["AI infrastructure", "data center", "liquid cooling", "optical networking", "power", "semiconductors"],
  },
  {
    id: "defense-autonomy",
    label: "Defense tech & autonomy",
    narrative:
      "Find emerging U.S.-listed defense-technology, drone, counter-drone, and autonomy companies winning recent government, NATO, or allied contracts. Favor specialized smaller players over prime contractors.",
    themes: ["defense tech", "drones", "autonomy", "counter-UAS", "government contracts", "C5ISR"],
  },
  {
    id: "biotech-catalysts",
    label: "Biotech near-term catalysts",
    narrative:
      "Find niche U.S.-listed biotech and medical-device companies with concrete near-term catalysts — upcoming FDA decisions, Phase 2/3 readouts, or recent breakthrough designations. Favor under-covered names, not big pharma.",
    themes: ["biotech", "FDA catalyst", "clinical readout", "gene editing", "medical devices", "oncology"],
  },
  {
    id: "robotics-reshoring",
    label: "Robotics & reshoring",
    narrative:
      "Find specialized U.S.-listed industrial-automation, robotics, machine-vision, and reshoring beneficiaries below mega-cap size that are gaining real commercial traction.",
    themes: ["robotics", "automation", "machine vision", "reshoring", "factory automation", "warehouse robots"],
  },
  {
    id: "space-materials",
    label: "Space & advanced materials",
    narrative:
      "Find U.S.-listed space, satellite, launch, and advanced-materials companies that have hit recent commercial milestones, new contracts, or revenue inflections. Favor specialized emerging names.",
    themes: ["space", "satellite", "launch", "advanced materials", "aerospace", "earth observation"],
  },
  {
    id: "energy-transition",
    label: "Energy transition niche",
    narrative:
      "Find niche U.S.-listed energy-transition plays the broad market overlooks — grid modernization, small modular nuclear, uranium, battery materials and recycling, and next-gen storage. Avoid the largest utilities and solar names.",
    themes: ["grid", "nuclear", "SMR", "uranium", "battery materials", "energy storage"],
  },
  {
    id: "fintech-crypto-infra",
    label: "Fintech & crypto infrastructure",
    narrative:
      "Find U.S.-listed fintech and crypto-infrastructure companies (payments, tokenization, stablecoin rails, mining efficiency, custody) benefiting from current regulatory shifts. Favor specialized up-and-comers over the household names.",
    themes: ["fintech", "crypto infrastructure", "payments", "tokenization", "stablecoins", "custody"],
  },
  {
    id: "fresh-listings",
    label: "Recent IPOs & spin-offs",
    narrative:
      "Find recently IPO'd or spun-off U.S.-listed companies from the last 18 months that the market may still be mispricing, with genuine revenue growth or a differentiated niche. Avoid stale large-caps.",
    themes: ["IPO", "spin-off", "new listing", "growth", "mispriced"],
  },
  {
    id: "cyber-data",
    label: "Cybersecurity & data infra",
    narrative:
      "Find up-and-coming U.S.-listed cybersecurity and data-infrastructure companies (identity, cloud security, observability, data pipelines) that are smaller than the established mega-cap leaders but growing fast.",
    themes: ["cybersecurity", "identity", "cloud security", "observability", "data infrastructure"],
  },
  {
    id: "policy-tailwinds",
    label: "Policy & legislation tailwinds",
    narrative:
      "Find U.S.-listed companies positioned to benefit from current policy and legislation tailwinds — onshoring incentives, semiconductor and clean-energy subsidies, tariffs, and infrastructure spending. Favor specialized mid- and small-caps.",
    themes: ["onshoring", "subsidies", "tariffs", "infrastructure", "domestic manufacturing"],
  },
  {
    id: "smart-money",
    label: "Insider & activist interest",
    narrative:
      "Find U.S.-listed companies with notable recent insider buying, activist-investor stakes, or unusual institutional accumulation, especially outside the obvious large-caps. Use recent filings and reputable coverage.",
    themes: ["insider buying", "activist investor", "13F", "institutional accumulation"],
  },
  {
    id: "consumer-culture",
    label: "Consumer & culture momentum",
    narrative:
      "Find U.S.-listed consumer, gaming, creator-economy, and culture brands gaining genuine viral traction or accelerating revenue, that aren't the usual mega-cap names.",
    themes: ["consumer brands", "gaming", "creator economy", "viral", "culture", "direct-to-consumer"],
  },
];

/**
 * Pick a rotating slice of missions so each refresh surfaces different niches.
 * Wraps around the full list using the persisted rotation index.
 */
export function selectMissions(rotationIndex: number, count: number): DiscoveryMission[] {
  const n = DISCOVERY_MISSIONS.length;
  if (n === 0) return [];
  const take = Math.min(count, n);
  const start = ((rotationIndex % n) + n) % n;
  const out: DiscoveryMission[] = [];
  for (let i = 0; i < take; i++) {
    out.push(DISCOVERY_MISSIONS[(start + i) % n]!);
  }
  return out;
}

export const DISCOVERY_MISSION_COUNT = DISCOVERY_MISSIONS.length;
