import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PortfolioMode } from "@/types";
import { useAppStore } from "@/store/useAppStore";
import { Modal } from "@/components/common/Modal";
import { PORTFOLIO_MODES } from "@/data/seedPortfolios";

export function CreatePortfolioModal({ onClose }: { onClose: () => void }) {
  const createPortfolio = useAppStore((s) => s.createPortfolio);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<PortfolioMode>("Balanced Aggressive");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const nameId = useId();
  const modeId = useId();
  const descId = useId();

  const submit = () => {
    if (!name.trim()) {
      setErr("Give your portfolio a name.");
      return;
    }
    setErr(null);
    const created = createPortfolio(name, mode, description);
    onClose();
    navigate(`/portfolios/${created.id}`);
  };

  return (
    <Modal
      title="Create portfolio"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!name.trim()}>
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor={nameId}>Name</label>
        <input
          id={nameId}
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (err) setErr(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="e.g. Pre-Earnings Movers"
        />
      </div>
      <div className="field">
        <label id={modeId}>Mode</label>
        <div className="chip-grid" role="radiogroup" aria-labelledby={modeId}>
          {PORTFOLIO_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={`chip-select ${mode === m ? "active" : ""}`}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor={descId}>Description</label>
        <textarea
          id={descId}
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What's the theme of this portfolio?"
        />
      </div>
      {err && (
        <p role="alert" style={{ color: "var(--bear, #e85d6f)", fontSize: 13, marginTop: 8 }}>
          {err}
        </p>
      )}
    </Modal>
  );
}
