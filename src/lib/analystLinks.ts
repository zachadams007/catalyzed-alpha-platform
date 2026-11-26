/** Deep links to third-party analyst / price-target pages (discovery only). */

function sym(ticker: string): string {
  return ticker.trim().toUpperCase();
}

export function yahooAnalysisUrl(ticker: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(sym(ticker))}/analysis/`;
}

export function tipRanksForecastUrl(ticker: string): string {
  return `https://www.tipranks.com/stocks/${encodeURIComponent(sym(ticker).toLowerCase())}/forecast`;
}

export function cnnMarketsUrl(ticker: string): string {
  return `https://www.cnn.com/markets/stocks/${encodeURIComponent(sym(ticker))}`;
}

export function marketWatchEstimatesUrl(ticker: string): string {
  return `https://www.marketwatch.com/investing/stock/${encodeURIComponent(sym(ticker).toLowerCase())}/analystestimates`;
}

export function finnhubSymbolUrl(ticker: string): string {
  return `https://finnhub.io/dashboard/stock/${encodeURIComponent(sym(ticker))}`;
}

export interface AnalystSourceLink {
  id: string;
  name: string;
  blurb: string;
  url: string;
}

/** Reputable outlets we link out to for analyst targets and estimates. */
export function analystSourceLinks(ticker: string): AnalystSourceLink[] {
  const s = sym(ticker);
  return [
    {
      id: "yahoo",
      name: "Yahoo Finance",
      blurb: "EPS/revenue estimates & trend",
      url: yahooAnalysisUrl(s),
    },
    {
      id: "tipranks",
      name: "TipRanks",
      blurb: "Analyst forecast & ratings",
      url: tipRanksForecastUrl(s),
    },
    {
      id: "cnn",
      name: "CNN Markets",
      blurb: "Quote & market context",
      url: cnnMarketsUrl(s),
    },
    {
      id: "marketwatch",
      name: "MarketWatch",
      blurb: "Analyst estimates table",
      url: marketWatchEstimatesUrl(s),
    },
  ];
}
