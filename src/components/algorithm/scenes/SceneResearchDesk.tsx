import { Link } from "react-router-dom";
import { isResearchProxyConfigured } from "@/data/http";

/**
 * The second engine - per-stock analyst diligence (the Research Desk at /research,
 * and the condensed "AI brief" on each stock page), as distinct from the market-wide
 * scan the rest of this story describes. It runs as a Supabase EDGE FUNCTION
 * (supabase/functions/research-agent) - the stages below restate that function's real
 * flow: a grounded Gemini read anchored to live Finnhub facts, then a Groq (Llama)
 * Bull ‖ Bear ‖ Judge debate. Keep in sync with that function (fidelity rule, CLAUDE.md).
 */

interface DeskStage {
  no: string;
  title: string;
  body: string;
}

const DESK_STAGES: DeskStage[] = [
  {
    no: "01",
    title: "Grounded research — an AI reads the live web",
    body:
      "An AI model — Google’s Gemini 2.5 Flash — runs a live Google Search on the company and writes raw research notes: today’s news, filings, analyst moves, and insider / Congress / President trades. First we pull the company’s VERIFIED current facts (price, profit/loss, recent insider trades) straight from Finnhub and hand them to the model, so it can’t repeat a stale number as if it were true.",
  },
  {
    no: "02",
    title: "Bull ‖ Bear — two AI analysts argue, in parallel",
    body:
      "A Bull analyst and a Bear analyst — both an AI model (Groq’s Llama 3.3 70B) — build the strongest evidence-based case FOR and AGAINST the stock at the same time, using ONLY the notes from step 1. Each point must be a specific, dated catalyst; anything invented is thrown out.",
  },
  {
    no: "03",
    title: "Judge — a third AI weighs the two cases",
    body:
      "A Judge (the same Llama model, a fresh pass) reads both sides against the notes and the verified facts and renders the verdict you see at the top of the desk and the brief: bullish / bearish / mixed, a 0–100 conviction, the bull and bear points that held up, and the catalysts and risks that mattered most. It rewards the better-EVIDENCED side, not the louder one.",
  },
  {
    no: "04",
    title: "Where it runs — on our server, keys server-side",
    body:
      "All three AI calls happen inside a Supabase edge function (our cloud), never in your app. The API keys for Gemini and Groq — the passwords that let us call those AIs — live there on the server; they’re never shipped to your phone or desktop. Every nontrivial claim traces to a real source the research step retrieved, or it’s dropped.",
  },
];

const DESK_GATES = [
  "Anchored to verified facts pulled live from Finnhub — no stale numbers",
  "Bull and bear argued separately, then judged on the evidence",
  "Every claim traces to a real, dated source the AI actually retrieved",
  "AI keys stay on our server — never shipped to your device",
  "Research only — no price targets, no buy/sell advice",
];

export function SceneResearchDesk() {
  const live = isResearchProxyConfigured();
  return (
    <section className="algo-fineprint desk-explainer" id="algo-research-desk">
      <div className="algo-fineprint__inner">
        <header className="algo-fineprint__head">
          <p className="algo-eyebrow">The second engine · per-stock diligence</p>
          <h2 className="algo-headline algo-headline--sm">The Research Desk — an AI analyst team</h2>
          <p className="algo-dek">
            The scan above sweeps the whole US market down to a daily scored board. The{" "}
            <Link to="/research" className="linkish">
              Research Desk
            </Link>{" "}
            (and the condensed AI brief on each stock page) goes deep on one — two AI models
            running on our server: one reads the live web, then a Bull, a Bear, and a Judge debate
            it out. It argues both sides and lands on a verdict; it never gives buy/sell advice.
          </p>
          <div className="desk-models" aria-label="Models and where they run">
            <span className="desk-model">
              <span className="desk-model__role">Grounded read</span>
              <span className="desk-model__name mono">Gemini 2.5 Flash</span>
            </span>
            <span className="desk-model__arrow" aria-hidden="true">→</span>
            <span className="desk-model">
              <span className="desk-model__role">Bull · Bear · Judge</span>
              <span className="desk-model__name mono">Groq · Llama 3.3 70B</span>
            </span>
            <span className="desk-model__host">
              <span className="desk-model__hostdot" aria-hidden="true" />
              runs in a Supabase edge function — keys stay server-side
            </span>
          </div>
        </header>

        <ol className="desk-pipeline">
          {DESK_STAGES.map((s) => (
            <li className="desk-stage" key={s.no}>
              <span className="desk-stage__no mono">{s.no}</span>
              <div>
                <h3 className="desk-stage__title">{s.title}</h3>
                <p className="desk-stage__body">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="desk-gates">
          <p className="desk-gates__title">Why you can trust the read</p>
          <ul className="desk-gates__list">
            {DESK_GATES.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
          <p className="desk-gates__foot">
            {live
              ? "The desk is connected — pick a stock on the Research tab, or hit “Generate AI brief” on any stock page."
              : "The desk runs on Google Gemini (the grounded web read) + Groq’s Llama (the Bull/Bear/Judge debate), both behind our server-side proxy — set VITE_RESEARCH_PROXY_URL to turn it on. The keys never reach your device."}{" "}
            Cited diligence, not a return oracle — no price targets, no buy/sell advice.
          </p>
        </div>
      </div>
    </section>
  );
}
