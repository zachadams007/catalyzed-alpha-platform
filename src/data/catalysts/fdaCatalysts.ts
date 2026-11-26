import type { CatalystType, CompanyData } from "@/types";
import { clamp } from "@/lib/math";
import { httpJson } from "@/data/http";
import { type CatalystEvent, daysAwayFrom, eventStrength } from "./catalystEvent";
import { buildNameTickerIndex, normalizeCompanyName } from "./usaSpendingCatalysts";

/**
 * FDA drug catalysts via the keyless openFDA Drugs@FDA endpoint.
 *
 * THE HONEST SCOPE (and the data-blocked flag)
 * --------------------------------------------
 * Forward-looking PDUFA *action dates* - the single highest-signal biotech
 * catalyst - are NOT freely available: openFDA is entirely retrospective
 * (approved-drug + adverse-event history only; verified 2026-06), and every free
 * PDUFA calendar (BioPharmaWatch ~6/978 rows, Assyro ticker-less) is gated or
 * symbol-less. So we DO NOT fabricate forward PDUFA dates. See
 * {@link FDA_FORWARD_PDUFA_BLOCKED} - surfacing a real forward PDUFA feed needs a
 * paid/auth source the owner must approve.
 *
 * What IS real and free: a recent FDA APPROVAL of a NEW drug (an original NDA /
 * BLA reaching status "AP") is a documented, dateable, market-moving catalyst.
 * We map those to a `Regulatory` catalyst, anchored to the universe by sponsor
 * name (same deterministic name→ticker match as the USASpending source - no
 * fuzzy matching onto names we don't rank). ANDA (generic) approvals are excluded
 * as low-signal noise.
 *
 * Keyless + bounded: one openFDA call per scan; degrades to [] on any error.
 */

/**
 * Forward-looking PDUFA action dates are DATA-BLOCKED at $0. This constant exists
 * so the gap is explicit in code (and greppable), not silently faked. Flip to a
 * real implementation only when a free/approved forward-PDUFA source is wired.
 */
export const FDA_FORWARD_PDUFA_BLOCKED =
  "Forward PDUFA action dates require a paid/auth feed (openFDA is retrospective; " +
  "free PDUFA calendars are gated or ticker-less). Not faked.";

/** Materiality: a novel-drug approval (original NDA/BLA) - high regulatory signal. */
const MAG_NEW_DRUG_APPROVAL = 0.8;
/** Approvals older than this many days are stale and excluded. */
const DEFAULT_LOOKBACK_DAYS = 30;

export interface DrugApproval {
  /** Sponsor (company) name as openFDA reports it. */
  sponsorName: string;
  /** FDA application number (e.g. "NDA218347"). */
  applicationNumber: string;
  /** Brand name of the approved drug, if any. */
  brandName?: string;
  /** ISO date of the approval (status "AP"). */
  dateIso: string;
  /** Drugs@FDA detail URL. */
  url: string;
  /** True for an original NDA/BLA (novel drug); false for supplements/generics. */
  isNovel: boolean;
}

/**
 * Map one approval to a catalyst event, resolving the sponsor to a universe
 * ticker via `nameIndex`. Returns null when the sponsor is not in the universe
 * or the approval is not a novel NDA/BLA. Pure - clock injected.
 */
export function approvalToCatalystEvent(
  approval: DrugApproval,
  nameIndex: ReadonlyMap<string, string>,
  now: number = Date.now(),
): CatalystEvent | null {
  if (!approval.isNovel) return null;
  const key = normalizeCompanyName(approval.sponsorName);
  const ticker = nameIndex.get(key);
  if (!ticker) return null;

  const mag = clamp(MAG_NEW_DRUG_APPROVAL, 0, 1);
  const daysAway = daysAwayFrom(approval.dateIso, now);
  const catalystType: CatalystType = "Regulatory";
  const drug = approval.brandName ? `${approval.brandName} ` : "";
  return {
    ticker,
    catalystType,
    date: approval.dateIso,
    summary: `FDA approval — ${drug}(${approval.applicationNumber})`,
    sourceUrl: approval.url,
    magnitude: mag,
    strength: eventStrength(mag, daysAway, false),
  };
}

/** Map a batch of approvals to events against a universe name index. */
export function approvalsToCatalystEvents(
  approvals: readonly DrugApproval[],
  nameIndex: ReadonlyMap<string, string>,
  now: number = Date.now(),
): CatalystEvent[] {
  const out: CatalystEvent[] = [];
  for (const approval of approvals) {
    const ev = approvalToCatalystEvent(approval, nameIndex, now);
    if (ev) out.push(ev);
  }
  return out;
}

// --------------------------------------------------------------------------
// Live fetch (I/O) - keyless openFDA, bounded, degrades to []. Pure mappers
// above are unit-tested; this network wrapper is not.
// --------------------------------------------------------------------------

const DRUGSFDA_URL = "https://api.fda.gov/drug/drugsfda.json";
const DRUGSFDA_DETAIL = "https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=";

interface FdaSubmission {
  submission_type?: string;
  submission_status?: string;
  submission_status_date?: string;
}
interface FdaProduct {
  brand_name?: string;
}
interface FdaResult {
  sponsor_name?: string;
  application_number?: string;
  submissions?: FdaSubmission[];
  products?: FdaProduct[];
}
interface FdaResponse {
  results?: FdaResult[];
}

/** "20240426" → "2024-04-26". Returns "" for an unparseable value. */
function parseFdaDate(yyyymmdd: string | undefined): string {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return "";
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** True for a novel new-drug application (NDA/BLA original), not a generic/ANDA. */
function isNovelApplication(appNumber: string): boolean {
  const a = appNumber.toUpperCase();
  return a.startsWith("NDA") || a.startsWith("BLA");
}

/** Pull the most recent ORIGINAL approval (status AP, type ORIG) from a result. */
export function resultToDrugApproval(r: FdaResult): DrugApproval | null {
  const sponsorName = (r.sponsor_name || "").trim();
  const applicationNumber = (r.application_number || "").trim();
  if (!sponsorName || !applicationNumber) return null;

  let bestDate = "";
  for (const s of r.submissions ?? []) {
    if (s.submission_status !== "AP") continue;
    if ((s.submission_type || "").toUpperCase() !== "ORIG") continue;
    const iso = parseFdaDate(s.submission_status_date);
    if (iso && iso > bestDate) bestDate = iso;
  }
  if (!bestDate) return null;

  return {
    sponsorName,
    applicationNumber,
    brandName: r.products?.[0]?.brand_name?.trim() || undefined,
    dateIso: bestDate,
    url: `${DRUGSFDA_DETAIL}${encodeURIComponent(applicationNumber.replace(/\D/g, ""))}`,
    isNovel: isNovelApplication(applicationNumber),
  };
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Fetch recent original FDA drug approvals (one keyless openFDA call) and map
 * them to catalyst events against the universe name index. Degrades to [] on any
 * error (including openFDA's intermittent 404 when a window has no matches).
 */
export async function fetchFdaCatalystEvents(
  companies: readonly CompanyData[],
  opts: { now?: number; lookbackDays?: number; limit?: number } = {},
): Promise<CatalystEvent[]> {
  if (companies.length === 0) return [];
  try {
    const now = opts.now ?? Date.now();
    const lookbackDays = opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const limit = opts.limit ?? 100;
    const today = new Date(now);
    const from = new Date(now - lookbackDays * 24 * 60 * 60 * 1000);
    const range = `[${ymd(from).replace(/-/g, "")}+TO+${ymd(today).replace(/-/g, "")}]`;
    const search =
      `submissions.submission_status_date:${range}` +
      `+AND+submissions.submission_status:AP+AND+submissions.submission_type:ORIG`;
    const url = `${DRUGSFDA_URL}?search=${search}&sort=submissions.submission_status_date:desc&limit=${limit}`;

    const res = await httpJson<FdaResponse>(url, { timeoutMs: 12_000 });
    const rows = res.results;
    if (!Array.isArray(rows)) return [];

    const nameIndex = buildNameTickerIndex(companies);
    const approvals = rows
      .map(resultToDrugApproval)
      .filter((a): a is DrugApproval => a !== null)
      // Honor the lookback strictly (the FDA range filter is on the submission,
      // but a result can carry an older ORIG approval we don't want).
      .filter((a) => {
        const d = daysAwayFrom(a.dateIso, now);
        return d <= 0 && d >= -lookbackDays;
      });
    return approvalsToCatalystEvents(approvals, nameIndex, now);
  } catch {
    return [];
  }
}
