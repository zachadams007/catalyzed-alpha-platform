import { useState } from "react";
import { Modal } from "@/components/common/Modal";
import { Skeleton } from "@/components/common/Skeleton";
import { useAppStore } from "@/store/useAppStore";
import {
  extractHoldingsFromImages,
  isVisionConfigured,
  type ExtractedHolding,
} from "@/data/vision/extractHoldings";
import { IconTrash, IconImage, IconPlus } from "@/components/icons";

type Stage = "pick" | "extracting" | "review" | "error";

interface Editable extends ExtractedHolding {
  include: boolean;
  /** Raw text for the shares/value cells, kept so an invalid entry stays visible
   *  (and editable) rather than snapping back to the last valid number. */
  sharesText: string;
  valueText: string;
}

/** A row is committable only when both numeric cells parse to a valid (or empty) value. */
function rowHasInvalidNumber(r: Editable): boolean {
  return parseNumericCell(r.sharesText) === null || parseNumericCell(r.valueText) === null;
}

/**
 * Parse a free-text numeric cell (shares / value) into a non-negative number.
 * Returns `undefined` for an empty cell and `null` for anything that isn't a
 * finite, non-negative number (letters, NaN, negatives) so the caller can flag
 * the row instead of letting `$NaN` flow into the portfolio analytics.
 */
export function parseNumericCell(raw: string): number | undefined | null {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  // Allow common entry formatting (commas / leading $) before parsing.
  const cleaned = trimmed.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

export function PhotoImportModal({
  portfolioId,
  initialMode = "add",
  onClose,
}: {
  portfolioId: string;
  initialMode?: "add" | "update";
  onClose: () => void;
}) {
  const addHoldingsBulk = useAppStore((s) => s.addHoldingsBulk);
  const upsertHoldingsBulk = useAppStore((s) => s.upsertHoldingsBulk);
  const portfolio = useAppStore((s) => s.portfolios.find((item) => item.id === portfolioId));
  const configured = isVisionConfigured();
  const [importMode, setImportMode] = useState<"add" | "update">(initialMode);
  const [stage, setStage] = useState<Stage>("pick");
  const [images, setImages] = useState<string[]>([]);
  const [rows, setRows] = useState<Editable[]>([]);
  const [error, setError] = useState<string>("");
  const [skipped, setSkipped] = useState<number>(0);

  const onFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError("");
    void Promise.all(Array.from(files).map(readFile)).then((urls) =>
      setImages((prev) => [...prev, ...urls]),
    );
  };

  const removeImage = (i: number) =>
    setImages((prev) => prev.filter((_, idx) => idx !== i));

  const runExtract = async () => {
    if (images.length === 0) return;
    setStage("extracting");
    setError("");
    try {
      const { holdings, perImage } = await extractHoldingsFromImages(images);
      if (holdings.length === 0) {
        setError(
          "Couldn't read any tickers from those images. Try sharper, cropped screenshots — or add them manually.",
        );
        setStage("error");
        return;
      }
      setSkipped(perImage.filter((p) => p.count === 0).length);
      setRows(
        holdings.map((h) => ({
          ...h,
          include: true,
          sharesText: h.shares != null ? String(h.shares) : "",
          valueText: h.value != null ? String(h.value) : "",
        })),
      );
      setStage("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Extraction failed.");
      setStage("error");
    }
  };

  const commit = () => {
    const picked = rows.filter((r) => r.include && r.ticker.trim());
    if (picked.length === 0) return;
    // Guard at the boundary too: never let an invalid cell reach the portfolio.
    if (picked.some(rowHasInvalidNumber)) return;
    const holdings = picked.map((r) => ({
      ticker: r.ticker,
      shares: parseNumericCell(r.sharesText) ?? undefined,
      value: parseNumericCell(r.valueText) ?? undefined,
    }));
    if (importMode === "update") upsertHoldingsBulk(portfolioId, holdings);
    else addHoldingsBulk(portfolioId, holdings);
    onClose();
  };

  const updateRow = (i: number, patch: Partial<Editable>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const includedCount = rows.filter((r) => r.include).length;
  const hasInvalidIncludedRow = rows.some((r) => r.include && rowHasInvalidNumber(r));
  const valuedCount = rows.filter((r) => {
    if (!r.include) return false;
    const v = parseNumericCell(r.valueText);
    return typeof v === "number" && v > 0;
  }).length;
  const existingTickers = new Set(portfolio?.holdings.map((holding) => holding.ticker) ?? []);

  const thumbStrip = (
    <div className="photo-import__thumbs" aria-label="Selected screenshots">
      {images.map((src, i) => (
        <div className="photo-import__thumb" key={i}>
          <img src={src} alt={`Screenshot ${i + 1}`} />
          <button
            type="button"
            className="photo-import__thumb-x"
            aria-label={`Remove screenshot ${i + 1}`}
            onClick={() => removeImage(i)}
          >
            <IconTrash size={12} />
          </button>
        </div>
      ))}
      <label className="photo-import__thumb photo-import__thumb--add">
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => onFiles(e.target.files)}
          className="photo-import__file"
        />
        <IconPlus size={18} />
        <span>Add more</span>
      </label>
    </div>
  );

  return (
    <Modal
      title={importMode === "update" ? "Update portfolio from photos" : "Import holdings from photos"}
      onClose={onClose}
      className="modal--wide"
    >
      {configured && (
        <div className="photo-import__mode" aria-label="Photo import behavior">
          <button
            type="button"
            className={importMode === "add" ? "is-active" : ""}
            aria-pressed={importMode === "add"}
            disabled={stage === "extracting"}
            onClick={() => setImportMode("add")}
          >
            Add new holdings
          </button>
          <button
            type="button"
            className={importMode === "update" ? "is-active" : ""}
            aria-pressed={importMode === "update"}
            disabled={stage === "extracting"}
            onClick={() => setImportMode("update")}
          >
            Update positions
          </button>
        </div>
      )}
      {!configured ? (
        <div className="photo-import__notice">
          <p>
            Photo import reads brokerage screenshots with AI — not available on this build. Add
            holdings manually below.
          </p>
        </div>
      ) : stage === "extracting" ? (
        <div className="photo-import__loading">
          {images[0] && (
            <img src={images[0]} alt="Portfolio screenshot" className="photo-import__preview" />
          )}
          <div className="grow">
            <p className="text-muted photo-import__loading-label">
              Reading {images.length} screenshot{images.length === 1 ? "" : "s"} & merging holdings…
            </p>
            <div className="photo-import__skel">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} width="100%" height={16} />
              ))}
            </div>
          </div>
        </div>
      ) : stage === "review" ? (
        <div className="photo-import__review">
          <p className="text-faint photo-import__review-note">
            Found {rows.length} holding{rows.length === 1 ? "" : "s"} across {images.length} image
            {images.length === 1 ? "" : "s"}
            {valuedCount > 0 ? ` · ${valuedCount} with a dollar value` : ""}. Uncheck mistakes, fix
            numbers, then {importMode === "update" ? "apply the snapshot" : "add them"}.
          </p>
          {importMode === "update" && (
            <p className="photo-import__merge-note">
              Matching tickers get their share count and value refreshed. Holdings missing from these
              screenshots stay untouched.
            </p>
          )}
          {skipped > 0 && (
            <p className="photo-import__warn">
              {skipped} image{skipped === 1 ? "" : "s"} read nothing — crop tighter and re-import if a
              holding is missing.
            </p>
          )}
          <div className="photo-import__rowhead">
            <span />
            <span>Ticker</span>
            <span>Status</span>
            <span>Shares</span>
            <span>Value&nbsp;($)</span>
            <span />
          </div>
          <div className="photo-import__rows">
            {rows.map((r, i) => (
              <div className="photo-import__row" key={i}>
                <input
                  type="checkbox"
                  checked={r.include}
                  onChange={(e) => updateRow(i, { include: e.target.checked })}
                  aria-label={`Include ${r.ticker}`}
                />
                <input
                  className="cell-input cell-input--ticker"
                  value={r.ticker}
                  onChange={(e) => updateRow(i, { ticker: e.target.value.toUpperCase() })}
                  aria-label="Ticker"
                />
                <span className="photo-import__row-status">
                  {existingTickers.has(r.ticker.trim().toUpperCase()) ? "Update" : "New"}
                </span>
                <input
                  className={`cell-input${
                    parseNumericCell(r.sharesText) === null ? " cell-input--invalid" : ""
                  }`}
                  inputMode="decimal"
                  placeholder="—"
                  value={r.sharesText}
                  aria-invalid={parseNumericCell(r.sharesText) === null}
                  onChange={(e) => updateRow(i, { sharesText: e.target.value })}
                  aria-label="Shares"
                />
                <input
                  className={`cell-input${
                    parseNumericCell(r.valueText) === null ? " cell-input--invalid" : ""
                  }`}
                  inputMode="decimal"
                  placeholder="—"
                  value={r.valueText}
                  aria-invalid={parseNumericCell(r.valueText) === null}
                  onChange={(e) => updateRow(i, { valueText: e.target.value })}
                  aria-label="Market value"
                />
                <button
                  className="icon-btn icon-btn--ghost"
                  aria-label={`Drop ${r.ticker}`}
                  onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                >
                  <IconTrash size={14} />
                </button>
              </div>
            ))}
          </div>
          {hasInvalidIncludedRow && (
            <p className="photo-import__warn" role="alert">
              Some shares/value cells aren’t valid numbers. Enter a number of 0 or more (or leave
              blank) to continue.
            </p>
          )}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={() => setStage("pick")}>
              Back
            </button>
            <button
              className="btn btn--primary"
              onClick={commit}
              disabled={includedCount === 0 || hasInvalidIncludedRow}
              title={
                hasInvalidIncludedRow
                  ? "Fix the highlighted shares/value cells (numbers ≥ 0 only) first."
                  : undefined
              }
            >
              {importMode === "update" ? "Apply" : "Add"} {includedCount} holding
              {includedCount === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      ) : (
        <div className="photo-import__pick">
          {stage === "error" && <p className="photo-import__error">{error}</p>}
          {images.length === 0 ? (
            <label className="photo-import__drop">
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => onFiles(e.target.files)}
                className="photo-import__file"
              />
              <div className="photo-import__drop-inner">
                <IconImage size={26} />
                <span className="photo-import__drop-title">Choose portfolio screenshots</span>
                <span className="text-faint photo-import__fine">
                  {importMode === "update"
                    ? "Upload a fresh account snapshot. Existing positions are refreshed and anything not shown is preserved."
                    : "Add several at once - one per account or scroll. We merge them and read the dollar value of each position for accurate weighting."}
                </span>
              </div>
            </label>
          ) : (
            thumbStrip
          )}
          <div className="modal__actions">
            <button className="btn btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={images.length === 0}
              onClick={runExtract}
            >
              Extract from {images.length || ""} {images.length === 1 ? "image" : "images"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
