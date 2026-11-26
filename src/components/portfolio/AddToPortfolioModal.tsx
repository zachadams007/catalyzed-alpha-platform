import { useState, type CSSProperties } from "react";
import type { PortfolioMode, StockSignal } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { Modal } from "@/components/common/Modal";
import { IconCheck, IconPlus } from "@/components/icons";
import { MODE_ACCENT, PORTFOLIO_MODES } from "@/data/seedPortfolios";

interface Props {
  signal: StockSignal;
  onClose: () => void;
}

export function AddToPortfolioModal({ signal, onClose }: Props) {
  const portfolios = useAppStore((s) => s.portfolios);
  const addToPortfolio = useAppStore((s) => s.addToPortfolio);
  const createPortfolio = useAppStore((s) => s.createPortfolio);

  const myPortfolios = portfolios.filter((p) => p.owner === "me");
  const [view, setView] = useState<"pick" | "create">(myPortfolios.length ? "pick" : "create");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<PortfolioMode>("High Volatility Catalyst");

  const handlePick = (portfolioId: string) => {
    addToPortfolio(portfolioId, signal);
    onClose();
  };

  const handleCreate = () => {
    const created = createPortfolio(name || `${signal.ticker} Ideas`, mode, "");
    addToPortfolio(created.id, signal);
    onClose();
  };

  return (
    <Modal title={`Add ${signal.ticker} to portfolio`} onClose={onClose}>
      {view === "pick" ? (
        <>
          <div className="col gap-2">
            {myPortfolios.map((p) => {
              const has = p.holdings.some((h) => h.ticker === signal.ticker);
              return (
                <button
                  key={p.id}
                  className="portfolio-pick"
                  onClick={() => !has && handlePick(p.id)}
                  disabled={has}
                >
                  <div className="row gap-3">
                    <span
                      className="portfolio-pick__mark"
                      style={{ "--portfolio-accent": MODE_ACCENT[p.mode] } as CSSProperties}
                    />
                    <div className="portfolio-pick__text">
                      <span className="portfolio-pick__name">{p.name}</span>
                      <span className="portfolio-pick__sub text-faint">
                        {p.holdings.length} holdings · {p.mode}
                      </span>
                    </div>
                  </div>
                  {has ? <IconCheck size={18} className="text-bull" /> : <IconPlus size={18} />}
                </button>
              );
            })}
          </div>
          <button className="btn btn--ghost" onClick={() => setView("create")}>
            <IconPlus size={16} /> New portfolio
          </button>
        </>
      ) : (
        <>
          <div className="field">
            <label>Portfolio name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${signal.ticker} Ideas`}
            />
          </div>
          <div className="field">
            <label>Mode</label>
            <div className="chip-grid">
              {PORTFOLIO_MODES.map((m) => (
                <button
                  key={m}
                  className={`chip-select ${mode === m ? "active" : ""}`}
                  onClick={() => setMode(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="row gap-3">
            <button className="btn btn--primary" onClick={handleCreate}>
              Create & add {signal.ticker}
            </button>
            {myPortfolios.length > 0 && (
              <button className="btn btn--ghost" onClick={() => setView("pick")}>
                Back
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
