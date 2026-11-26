/**
 * Curated theme tags for Blueprint - merged into narrative keyword expansion.
 * Sample-data universe includes fictional names aligned with several themes.
 */

export interface ScreenThemeTag {
  id: string;
  label: string;
  /** Extra tokens beyond the label itself. */
  keywords: string[];
}

export const SCREEN_THEME_TAGS: ScreenThemeTag[] = [
  { id: "quantum", label: "Quantum", keywords: ["quantum", "qubit", "photonic", "superconducting", "cryogenic"] },
  { id: "cybersecurity", label: "Cybersecurity", keywords: ["cybersecurity", "cyber security", "endpoint security", "ransomware", "firewall", "zero trust", "threat detection", "identity security", "vulnerability management", "sase"] },
  { id: "quantum-security", label: "Quantum security", keywords: ["post-quantum", "quantum-safe", "quantum-resistant", "post quantum cryptography", "quantum encryption", "quantum key", "cryptography", "encryption", "crypto-agility"] },
  { id: "ai-infra", label: "AI infrastructure", keywords: ["datacenter", "data center", "hyperscale", "gpu", "accelerator", "interconnect", "liquid cooling", "inference", "optical transceiver", "silicon photonics", "power management", "electrification"] },
  { id: "nuclear", label: "Nuclear / SMR", keywords: ["nuclear", "uranium", "small modular reactor", "microreactor", "haleu", "triso", "fission", "enrichment"] },
  { id: "defense", label: "Defense tech", keywords: ["defense", "drone", "missile", "hypersonic", "munitions", "counter-drone", "loitering munition", "unmanned", "electronic warfare", "autonomous systems"] },
  { id: "rare-earths", label: "Rare earths", keywords: ["rare earth", "neodymium", "praseodymium", "dysprosium", "terbium", "permanent magnet", "critical mineral", "monazite"] },
  { id: "glp1", label: "GLP-1 / metabolic", keywords: ["glp-1", "semaglutide", "tirzepatide", "orforglipron", "obesity", "weight loss", "incretin", "amylin", "metabolic"] },
  { id: "robotics", label: "Robotics", keywords: ["robot", "robotics", "automation", "humanoid", "cobot", "warehouse", "physical ai", "embodied ai", "actuator"] },
  { id: "ai", label: "AI / ML", keywords: ["artificial", "inference", "gpu", "llm", "model", "training"] },
  { id: "biotech", label: "Biotech", keywords: ["clinical", "trial", "fda", "therapy", "genomic", "biologic"] },
  { id: "space", label: "Space", keywords: ["satellite", "launch", "orbital", "aerospace", "defense", "spacecraft", "launch services", "lunar", "earth observation", "direct-to-device"] },
  { id: "clean", label: "Clean energy", keywords: ["solar", "battery", "ev", "hydrogen", "grid", "lithium"] },
  { id: "fintech", label: "Fintech", keywords: ["payments", "neobank", "lending", "crypto", "blockchain"] },
  { id: "semis", label: "Semiconductors", keywords: ["chip", "fab", "foundry", "asic", "packaging", "eda"] },
  { id: "meme", label: "Retail hype", keywords: ["meme", "retail", "squeeze", "viral", "trending", "wsb"] },
  { id: "political", label: "Policy / DC", keywords: ["congress", "lobby", "subsidy", "tariff", "regulation", "policy"] },
];

export function themeTagById(id: string): ScreenThemeTag | undefined {
  return SCREEN_THEME_TAGS.find((t) => t.id === id);
}
