/**
 * Curated one-line company descriptions - "what this company actually does".
 *
 * WHY THIS EXISTS
 * The display blurb on the stock-detail page used to read "Rocket Lab is a
 * technology company" - the generic sector fallback in enrich.ts. That happens
 * because the bulk daily scan's per-name Finnhub `profile2` calls get throttled
 * (free 60/min tier across a 500-name scan), so `finnhubIndustry` is almost always
 * null and the "specific industry" path never fires. The result was a useless
 * one-liner that told you nothing about the business.
 *
 * This file is the fix: a hand-curated, FACTUAL one-sentence description of what
 * each company does, keyed by ticker. It is applied at the store ingest boundary
 * (overlayCompanyBlurbs, see trustedMajors-style overlay in useAppStore) so it
 * lands on EVERY surface immediately - including the already-scored shared board -
 * without waiting for a rescan.
 *
 * RULES
 * - NEVER fabricate. Only names whose business is genuinely known are listed here.
 *   Anything not in this map falls back to the finnhubIndustry/sector phrasing in
 *   enrich.ts (buildCompanyBlurb) - a weaker but honest generic line.
 * - One sentence, plain language, lead with what they sell/build/operate. No hype,
 *   no financial claims, no "leading"/"world-class" filler.
 * - Keep it to the names that actually surface (the ~200 market majors plus the
 *   recurring catalyst / AI-pick / small-cap momentum names). Extend as needed.
 */

const RAW: Record<string, string> = {
  // ── Mega-cap tech & semis ───────────────────────────────────────────────
  NVDA: "Nvidia designs the GPUs and AI accelerators that power data-center machine learning, gaming, and robotics.",
  AAPL: "Apple makes the iPhone, Mac, iPad, and wearables, and runs the App Store and services tied to them.",
  MSFT: "Microsoft sells Windows, Office, the Azure cloud platform, and enterprise software, and owns a large stake in OpenAI.",
  GOOGL: "Alphabet is the parent of Google — search, YouTube, Android, and the Google Cloud platform, funded mostly by advertising.",
  GOOG: "Alphabet is the parent of Google — search, YouTube, Android, and the Google Cloud platform, funded mostly by advertising.",
  AMZN: "Amazon runs the largest U.S. e-commerce marketplace and AWS, the leading cloud-computing platform.",
  META: "Meta operates Facebook, Instagram, WhatsApp, and Threads, earning almost all revenue from advertising and investing heavily in AI and VR.",
  AVGO: "Broadcom designs networking, broadband, and custom AI chips, and sells infrastructure software after acquiring VMware.",
  TSLA: "Tesla builds electric vehicles, energy-storage systems, and solar products, and is developing self-driving software.",
  AMD: "AMD designs CPUs and GPUs for PCs, servers, and AI data centers, competing with Intel and Nvidia.",
  INTC: "Intel designs and manufactures CPUs and is building out contract chip-foundry operations.",
  MU: "Micron makes DRAM and NAND memory chips used in PCs, phones, data centers, and AI accelerators.",
  QCOM: "Qualcomm designs the Snapdragon chips and modem technology that run most premium smartphones.",
  TXN: "Texas Instruments makes analog and embedded-processing chips used across industrial and automotive electronics.",
  ORCL: "Oracle sells database software and a fast-growing cloud-infrastructure business for enterprises.",
  CRM: "Salesforce sells cloud-based customer-relationship-management and enterprise software.",
  ADBE: "Adobe makes creative software (Photoshop, Illustrator) and document and marketing tools, sold by subscription.",
  CSCO: "Cisco makes the networking hardware and software that route enterprise and internet traffic.",
  IBM: "IBM sells enterprise software, hybrid-cloud services, consulting, and mainframe systems.",
  AMAT: "Applied Materials builds the equipment chipmakers use to manufacture semiconductors.",
  LRCX: "Lam Research makes the etch and deposition machines used in semiconductor fabrication.",
  KLAC: "KLA makes inspection and measurement equipment that finds defects in chip manufacturing.",
  MRVL: "Marvell designs custom data-center, networking, and storage chips, including AI infrastructure silicon.",
  ADI: "Analog Devices makes high-performance analog and mixed-signal chips for industrial and automotive use.",
  MPWR: "Monolithic Power Systems makes power-management chips for computing, automotive, and industrial systems.",
  NXPI: "NXP Semiconductors makes chips for automotive, industrial, and secure-payment applications.",
  SNPS: "Synopsys makes the software (EDA) and IP that engineers use to design semiconductors.",
  CDNS: "Cadence makes electronic-design-automation software used to design chips and electronic systems.",
  PLTR: "Palantir builds data-analytics and AI software platforms (Gotham, Foundry, AIP) for governments and enterprises.",
  NOW: "ServiceNow sells a cloud platform that automates IT, HR, and business workflows for large organizations.",
  INTU: "Intuit makes TurboTax, QuickBooks, and Credit Karma — tax, accounting, and personal-finance software.",
  PANW: "Palo Alto Networks sells enterprise cybersecurity — firewalls, cloud security, and security operations software.",
  CRWD: "CrowdStrike sells cloud-delivered endpoint and threat-detection cybersecurity software.",
  FTNT: "Fortinet makes firewalls and network-security appliances and software for enterprises.",
  NET: "Cloudflare runs a global network that speeds up and protects websites, apps, and APIs.",
  DDOG: "Datadog sells cloud monitoring and observability software that tracks the health of apps and infrastructure.",
  SNOW: "Snowflake runs a cloud data-warehouse platform for storing, sharing, and analyzing large datasets.",
  UBER: "Uber operates the ride-hailing and food-delivery (Uber Eats) marketplaces and a freight-brokerage business.",
  SHOP: "Shopify provides the software small and mid-sized merchants use to run online stores.",
  APP: "AppLovin runs an AI-driven advertising and app-monetization platform for mobile developers.",
  DELL: "Dell makes PCs, servers, and storage hardware and is a major supplier of AI-server infrastructure.",
  HPQ: "HP makes personal computers and printers.",
  ACN: "Accenture is a global IT-consulting and technology-services firm.",
  CRWV: "CoreWeave rents out GPU cloud-computing capacity for AI training and inference.",
  NBIS: "Nebius builds and rents GPU cloud infrastructure for AI workloads.",
  ALAB: "Astera Labs makes connectivity chips that link processors, memory, and accelerators inside AI data centers.",
  VRT: "Vertiv makes the power and cooling hardware that keeps data centers running.",
  ANET: "Arista Networks makes high-speed switches and networking software for cloud and AI data centers.",
  SMCI: "Super Micro builds high-performance servers and storage systems, including AI/GPU servers.",
  COHR: "Coherent makes lasers, optics, and optical-networking components used in communications and manufacturing.",
  GLW: "Corning makes specialty glass and ceramics — Gorilla Glass, optical fiber, and display glass.",
  STX: "Seagate makes hard-disk drives and data-storage systems.",
  WDC: "Western Digital makes hard drives and flash storage.",
  SNDK: "SanDisk makes flash-memory storage products.",

  // ── Quantum / speculative AI & robotics small-caps (recurring AI picks) ──
  RGTI: "Rigetti Computing builds superconducting quantum computers and sells access to them over the cloud.",
  QUBT: "Quantum Computing Inc. makes photonic quantum and thermal-imaging hardware.",
  IONQ: "IonQ builds trapped-ion quantum computers and offers them through cloud platforms.",
  QBTS: "D-Wave Quantum makes quantum-annealing computers aimed at optimization problems.",
  SERV: "Serve Robotics makes autonomous sidewalk delivery robots used for food and goods delivery.",
  U: "Unity makes the game-engine and real-time 3D development software used to build games and interactive apps, plus mobile ad-monetization tools.",
  PATH: "UiPath sells robotic-process-automation software that automates repetitive office tasks.",
  AI: "C3.ai sells enterprise AI application software for large organizations.",
  SOUN: "SoundHound AI makes voice-recognition and conversational-AI software for cars, restaurants, and devices.",
  BBAI: "BigBear.ai sells AI-driven decision-intelligence and analytics software, largely to government customers.",

  // ── Biotech / pharma / healthcare ───────────────────────────────────────
  LLY: "Eli Lilly makes pharmaceuticals, including the GLP-1 diabetes and weight-loss drugs Mounjaro and Zepbound.",
  JNJ: "Johnson & Johnson makes pharmaceuticals and medical devices.",
  MRK: "Merck makes pharmaceuticals and vaccines, anchored by the cancer drug Keytruda.",
  ABBV: "AbbVie makes pharmaceuticals, including immunology drugs Humira, Skyrizi, and Rinvoq.",
  PFE: "Pfizer makes pharmaceuticals and vaccines.",
  BMY: "Bristol-Myers Squibb makes pharmaceuticals, focused on oncology, cardiovascular, and immunology drugs.",
  AMGN: "Amgen makes biologic medicines for cancer, inflammation, and cardiovascular disease.",
  GILD: "Gilead Sciences makes antiviral medicines for HIV and hepatitis, plus a growing oncology portfolio.",
  VRTX: "Vertex Pharmaceuticals makes medicines for cystic fibrosis and is developing gene and pain therapies.",
  AZN: "AstraZeneca makes pharmaceuticals across oncology, cardiovascular, and respiratory disease.",
  CRSP: "CRISPR Therapeutics develops CRISPR/Cas9 gene-editing medicines, including the sickle-cell therapy Casgevy.",
  NTLA: "Intellia Therapeutics develops in-vivo CRISPR gene-editing therapies.",
  BEAM: "Beam Therapeutics develops base-editing gene therapies.",
  MRNA: "Moderna makes mRNA vaccines and is developing mRNA therapies and cancer vaccines.",
  ISRG: "Intuitive Surgical makes the da Vinci robotic-surgery systems and instruments.",
  TMO: "Thermo Fisher makes lab equipment, reagents, and analytical instruments for life-sciences research.",
  DHR: "Danaher makes life-sciences and diagnostics instruments and consumables.",
  ABT: "Abbott makes medical devices, diagnostics, nutrition products, and generic medicines.",
  MDT: "Medtronic makes medical devices for cardiac, surgical, diabetes, and neurological care.",
  SYK: "Stryker makes orthopedic implants, surgical equipment, and medical devices.",
  UNH: "UnitedHealth runs health-insurance plans and the Optum health-services and pharmacy business.",
  CVS: "CVS Health runs retail pharmacies, the Aetna health-insurance business, and a pharmacy-benefits manager.",
  ELV: "Elevance Health is a major U.S. health-insurance company (formerly Anthem).",
  CI: "Cigna runs health-insurance plans and the Evernorth pharmacy-and-health-services business.",
  HCA: "HCA Healthcare operates hospitals and surgery centers across the U.S.",
  MCK: "McKesson distributes pharmaceuticals and medical supplies to pharmacies and providers.",
  MYO: "Myomo makes a wearable robotic arm brace (the MyoPro) for people with arm paralysis or weakness.",
  ASPI: "ASP Isotopes uses laser technology to enrich and produce specialty isotopes for medical, nuclear, and industrial use.",

  // ── Financials ──────────────────────────────────────────────────────────
  BRKB: "Berkshire Hathaway is Warren Buffett's holding company, spanning insurance, railroads, energy, and consumer brands.",
  JPM: "JPMorgan Chase is the largest U.S. bank, spanning consumer banking, investment banking, and asset management.",
  BAC: "Bank of America is a large U.S. consumer and commercial bank.",
  WFC: "Wells Fargo is a large U.S. consumer and commercial bank.",
  C: "Citigroup is a global bank focused on institutional and cross-border banking and U.S. consumer cards.",
  GS: "Goldman Sachs is an investment bank and asset manager.",
  MS: "Morgan Stanley is an investment bank and wealth-and-asset manager.",
  V: "Visa runs the largest card-payment network, earning fees on transactions worldwide.",
  MA: "Mastercard runs a global card-payment network, earning fees on transactions.",
  AXP: "American Express issues premium credit cards and runs its own payments network.",
  PYPL: "PayPal runs digital-payment platforms including PayPal, Venmo, and Braintree.",
  SOFI: "SoFi is a digital bank offering lending, banking, and investing through a single app.",
  HOOD: "Robinhood runs a commission-free app for trading stocks, options, and crypto.",
  COIN: "Coinbase runs a major U.S. cryptocurrency exchange and custody platform.",
  SCHW: "Charles Schwab is a brokerage and wealth-management firm.",
  BLK: "BlackRock is the world's largest asset manager and runs the iShares ETF business.",
  KKR: "KKR is a private-equity and alternative-asset-management firm.",
  BX: "Blackstone is the world's largest alternative-asset manager (private equity, real estate, credit).",
  SPGI: "S&P Global provides credit ratings, market data, and indices.",
  ICE: "Intercontinental Exchange runs exchanges (including the NYSE) and mortgage and data businesses.",
  CME: "CME Group runs the largest futures and derivatives exchanges.",
  PGR: "Progressive is a major U.S. auto and property insurer.",
  COF: "Capital One is a consumer bank and one of the largest U.S. credit-card issuers.",

  // ── Consumer ────────────────────────────────────────────────────────────
  WMT: "Walmart is the largest U.S. retailer, running supercenters, grocery, and a growing e-commerce and ads business.",
  COST: "Costco runs membership warehouse clubs.",
  HD: "Home Depot is the largest U.S. home-improvement retailer.",
  LOW: "Lowe's is a major U.S. home-improvement retailer.",
  PG: "Procter & Gamble makes consumer staples — Tide, Pampers, Gillette, and other household brands.",
  KO: "Coca-Cola makes and distributes soft drinks and other non-alcoholic beverages worldwide.",
  PEP: "PepsiCo makes beverages and snacks, including Pepsi, Gatorade, Frito-Lay, and Quaker.",
  MCD: "McDonald's runs and franchises the world's largest fast-food restaurant chain.",
  SBUX: "Starbucks runs and licenses the global coffeehouse chain.",
  NKE: "Nike designs and sells athletic footwear and apparel.",
  DIS: "Disney makes films and TV, runs theme parks and cruises, and operates the Disney+ and ESPN streaming services.",
  NFLX: "Netflix runs the global subscription video-streaming service and produces original content.",
  TGT: "Target is a large U.S. general-merchandise retailer.",
  BKNG: "Booking Holdings runs online travel sites including Booking.com and Priceline.",
  ABNB: "Airbnb runs the global marketplace for short-term home and room rentals.",
  MELI: "MercadoLibre runs the largest e-commerce and fintech platform in Latin America.",
  GM: "General Motors makes vehicles under Chevrolet, GMC, Buick, and Cadillac and is developing EVs.",
  F: "Ford makes vehicles, including the F-150 trucks, and is investing in EVs.",
  CMG: "Chipotle runs the fast-casual Mexican-grill restaurant chain.",
  DASH: "DoorDash runs the largest U.S. food-delivery marketplace.",

  // ── Industrials / aerospace / energy / materials ────────────────────────
  RKLB: "Rocket Lab builds and launches small Electron orbital rockets and makes satellites and spacecraft components.",
  BA: "Boeing makes commercial jets, defense aircraft, and space systems.",
  LMT: "Lockheed Martin makes military aircraft (F-35), missiles, and space and defense systems.",
  RTX: "RTX makes aerospace and defense systems — jet engines (Pratt & Whitney), avionics, and missiles.",
  NOC: "Northrop Grumman makes military aircraft, missiles, and defense and space systems.",
  GD: "General Dynamics makes combat vehicles, warships, munitions, and Gulfstream business jets.",
  GE: "GE Aerospace makes jet engines and aviation systems for commercial and military aircraft.",
  GEV: "GE Vernova makes power-generation equipment — gas, wind, and grid technology.",
  HON: "Honeywell makes aerospace systems, building controls, and industrial automation and materials.",
  CAT: "Caterpillar makes construction and mining equipment, engines, and turbines.",
  DE: "Deere (John Deere) makes agricultural and construction machinery and precision-farming technology.",
  UNP: "Union Pacific runs a major U.S. freight railroad.",
  UPS: "UPS is a global package-delivery and logistics company.",
  FDX: "FedEx is a global package-delivery and logistics company.",
  XOM: "ExxonMobil produces, refines, and sells oil, natural gas, and chemicals.",
  CVX: "Chevron produces, refines, and sells oil, natural gas, and chemicals.",
  COP: "ConocoPhillips explores for and produces oil and natural gas.",
  SLB: "SLB (Schlumberger) provides drilling and oilfield-services technology to energy producers.",
  NEE: "NextEra Energy runs a Florida regulated utility and the largest U.S. wind-and-solar generation business.",
  CEG: "Constellation Energy is the largest U.S. operator of nuclear power plants and sells clean electricity.",
  VST: "Vistra is an independent power producer with a large nuclear and gas generation fleet.",
  OKLO: "Oklo is developing small modular nuclear reactors to sell power under long-term contracts.",
  SMR: "NuScale Power is developing small modular nuclear reactors.",
  BE: "Bloom Energy makes solid-oxide fuel cells that generate on-site electricity.",
  FSLR: "First Solar makes thin-film solar panels and builds large solar projects.",
  ENPH: "Enphase Energy makes microinverters and battery systems for residential solar.",
  LIN: "Linde produces and distributes industrial gases (oxygen, hydrogen, nitrogen).",
  FCX: "Freeport-McMoRan mines copper and gold.",
  NEM: "Newmont is the world's largest gold miner.",
  BMNR: "Bitmine Immersion Technologies makes immersion-cooling systems for bitcoin mining and runs mining operations.",
  MP: "MP Materials mines and processes rare-earth elements used in magnets for EVs, electronics, and defense.",

  // ── Comms / media / telecom ─────────────────────────────────────────────
  TMUS: "T-Mobile is a major U.S. wireless carrier.",
  VZ: "Verizon is a major U.S. wireless and broadband carrier.",
  T: "AT&T is a major U.S. wireless and broadband carrier.",
  CMCSA: "Comcast runs Xfinity broadband, NBCUniversal media, and the Peacock streaming service.",
  SPOT: "Spotify runs the global music and podcast streaming service.",
};

/** Curated description map, keyed by UPPERCASE ticker. */
export const COMPANY_DESCRIPTIONS: Record<string, string> = Object.freeze(
  Object.fromEntries(Object.entries(RAW).map(([t, d]) => [t.toUpperCase(), d])),
);

/**
 * Best curated "what it does" description for a ticker, or undefined when we have
 * no grounded copy for it (caller should fall back to the industry/sector phrase).
 */
export function describeCompany(ticker: string | undefined | null): string | undefined {
  if (!ticker) return undefined;
  return COMPANY_DESCRIPTIONS[ticker.trim().toUpperCase()];
}

/**
 * Ingest-boundary overlay: fill `companyBlurb` from the curated map for any name
 * we have grounded copy for. Applied ONCE at store ingest (alongside the trusted-
 * majors overlay) so the already-scored shared board immediately shows real
 * descriptions instead of the stale "X is a <sector> company" string baked in by
 * an older scan - no rescan or redeploy required. Pure; returns a new array and
 * leaves off-map names (and their existing fallback blurb) untouched. Idempotent.
 */
export function overlayCompanyBlurbs<T extends { ticker: string; companyBlurb?: string }>(
  signals: T[],
): T[] {
  return signals.map((s) => {
    const curated = describeCompany(s.ticker);
    if (!curated || curated === s.companyBlurb) return s;
    return { ...s, companyBlurb: curated };
  });
}
