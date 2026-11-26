import type { CatalystType, NewsItem, RawCatalyst } from "@/types";

interface CatalystRule {
  type: CatalystType;
  patterns: RegExp[];
  defaultMagnitude: number;
  defaultDaysAway: number;
}

const RULES: CatalystRule[] = [
  {
    type: "Earnings",
    patterns: [/earnings/i, /\bEPS\b/i, /\bQ[1-4]\b/i, /guidance/i, /beat/i, /miss/i, /revenue/i],
    defaultMagnitude: 0.75,
    defaultDaysAway: 7,
  },
  {
    type: "Clinical",
    patterns: [/FDA/i, /trial/i, /phase\s*[123]/i, /approval/i, /PDUFA/i, /drug/i],
    defaultMagnitude: 0.82,
    defaultDaysAway: 14,
  },
  {
    type: "M&A",
    patterns: [/acqui/i, /merger/i, /buyout/i, /takeover/i, /deal/i],
    defaultMagnitude: 0.78,
    defaultDaysAway: 21,
  },
  {
    type: "Political",
    patterns: [/congress/i, /senate/i, /white house/i, /tariff/i, /regulation/i, /defense/i, /policy/i],
    defaultMagnitude: 0.65,
    defaultDaysAway: 10,
  },
  {
    type: "Product",
    patterns: [/launch/i, /product/i, /chip/i, /AI/i, /partnership/i, /contract/i],
    defaultMagnitude: 0.6,
    defaultDaysAway: 14,
  },
  {
    type: "Macro",
    patterns: [/Fed/i, /inflation/i, /rates/i, /jobs report/i, /GDP/i, /recession/i],
    defaultMagnitude: 0.55,
    defaultDaysAway: 5,
  },
];

function hoursSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 48;
  return Math.max(1, (Date.now() - t) / 3_600_000);
}

function matchRule(text: string): CatalystRule | undefined {
  for (const rule of RULES) {
    if (rule.patterns.some((p) => p.test(text))) return rule;
  }
  return undefined;
}

/** Rule-based catalyst inference from verified headline URLs (hybrid path without LLM). */
export function inferCatalystFromNews(
  items: NewsItem[],
  companyName: string,
  fallback: RawCatalyst,
): RawCatalyst {
  if (items.length === 0) return fallback;

  const top = items[0]!;
  const corpus = items
    .slice(0, 5)
    .map((n) => n.headline)
    .join(" ");
  const rule = matchRule(corpus);
  const freshestHours = hoursSince(top.publishedAt);

  if (!rule) {
    return {
      type: "Regulatory",
      description: top.headline,
      daysAway: freshestHours < 24 ? 0 : Math.min(14, Math.round(freshestHours / 24)),
      magnitude: Math.min(0.85, 0.45 + items.length * 0.04),
    };
  }

  const lead = items.find((n) => rule.patterns.some((p) => p.test(n.headline))) ?? top;
  return {
    type: rule.type,
    description: `${companyName}: ${lead.headline}`,
    daysAway: rule.defaultDaysAway,
    magnitude: rule.defaultMagnitude,
  };
}

/** Lightweight sentiment from headline wording (-1 .. 1). */
export function sentimentFromHeadlines(items: NewsItem[]): number {
  if (items.length === 0) return 0;
  const pos = /\b(surge|rally|beat|upgrade|record|growth|win|approval|strong)\b/i;
  const neg = /\b(fall|drop|miss|downgrade|cut|lawsuit|probe|weak|delay|reject)\b/i;
  let score = 0;
  for (const item of items.slice(0, 8)) {
    if (pos.test(item.headline)) score += 1;
    if (neg.test(item.headline)) score -= 1;
  }
  return Math.max(-1, Math.min(1, score / Math.max(1, items.length)));
}
