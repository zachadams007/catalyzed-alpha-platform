import { Fragment, useMemo, useState, type CSSProperties } from "react";
import { IconArrowDown, IconArrowUp, IconMinus, IconPlus, IconTrash } from "@/components/icons";
import type { HoldingRow } from "@/engine/portfolioAnalytics";
import { SplitAdjustmentNote } from "@/components/portfolio/SplitAdjustmentNote";
import {
  formatCurrency,
  formatNumber,
  formatPct,
  formatPctPlain,
  formatPrice,
  formatSignedCurrency,
} from "@/lib/format";
import { useAppStore } from "@/store/useAppStore";

type WeightStyle = CSSProperties & {
  "--holding-weight": string;
};

type DayStyle = CSSProperties & {
  "--day-mag": string;
};

type SortKey = "ticker" | "shares" | "costBasis" | "price" | "dayChange" | "marketValue" | "pl" | "weight";
type SortDir = "asc" | "desc";

interface SortColumn {
  key: SortKey;
  label: string;
  /** Numeric columns are right-aligned + default to descending. */
  numeric: boolean;
  ownedOnly?: boolean;
}

const COLUMNS: ReadonlyArray<SortColumn> = [
  { key: "ticker", label: "Holding", numeric: false },
  { key: "shares", label: "Shares", numeric: true },
  { key: "costBasis", label: "Avg cost", numeric: true },
  { key: "price", label: "Price", numeric: true },
  { key: "dayChange", label: "Day", numeric: true },
  { key: "marketValue", label: "Value", numeric: true },
  { key: "pl", label: "P/L", numeric: true },
  { key: "weight", label: "Weight", numeric: true },
];

const DAY_CHANGE_REFERENCE_MAG = 0.05;

function plClass(value: number | undefined): string {
  if (value == null || value === 0) return "text-faint";
  return value > 0 ? "pl-pos" : "pl-neg";
}

function compareRows(a: HoldingRow, b: HoldingRow, key: SortKey, dir: SortDir): number {
  const factor = dir === "asc" ? 1 : -1;
  if (key === "ticker") return a.ticker.localeCompare(b.ticker) * factor;
  const av = a[key];
  const bv = b[key];
  // Undefined values always sink to the bottom regardless of direction.
  if (av == null && bv == null) return a.ticker.localeCompare(b.ticker);
  if (av == null) return 1;
  if (bv == null) return -1;
  const primary = ((av as number) - (bv as number)) * factor;
  return primary !== 0 ? primary : a.ticker.localeCompare(b.ticker);
}

function DayCell({ row }: { row: HoldingRow }) {
  const day = row.dayChange;
  if (day == null) return <span className="text-faint">-</span>;
  // Bar magnitude scaled so a ±5% day fills the bar; clamp for outliers.
  const mag = Math.min(1, Math.abs(day) / DAY_CHANGE_REFERENCE_MAG);
  const style: DayStyle = { "--day-mag": `${mag * 100}%` };
  const dir = day > 0 ? "up" : day < 0 ? "down" : "flat";
  return (
    <span className={`day-cell day-cell--${dir}`} style={style}>
      <span className={`day-cell__val mono ${plClass(day)}`}>{formatPct(day)}</span>
      <span className="day-cell__bar" aria-hidden="true">
        <span className="day-cell__fill" />
      </span>
    </span>
  );
}

function PerformanceValue({ row }: { row: HoldingRow }) {
  if (row.pl == null) return <span className="text-faint">-</span>;

  const DirectionIcon = row.pl > 0 ? IconArrowUp : row.pl < 0 ? IconArrowDown : IconMinus;
  const direction = row.pl > 0 ? "Gain" : row.pl < 0 ? "Loss" : "Flat";

  return (
    <span className={`holding-pl ${plClass(row.pl)}`} aria-label={`${direction} ${formatSignedCurrency(row.pl)}`}>
      <DirectionIcon size={14} />
      <span>
        {formatSignedCurrency(row.pl)}
        {row.plPct != null && <span className="pl-pct">{formatPct(row.plPct)}</span>}
      </span>
    </span>
  );
}

function EditRow({
  row,
  portfolioId,
  owned,
  onSelectTicker,
  colSpan,
}: {
  row: HoldingRow;
  portfolioId: string;
  owned: boolean;
  onSelectTicker?: (ticker: string) => void;
  colSpan: number;
}) {
  const updateHolding = useAppStore((s) => s.updateHolding);
  const removeFromPortfolio = useAppStore((s) => s.removeFromPortfolio);
  const [shares, setShares] = useState(row.shares != null ? String(row.shares) : "");
  const [cost, setCost] = useState(row.costBasis != null ? String(row.costBasis) : "");
  const [value, setValue] = useState(row.importedValue != null ? String(row.importedValue) : "");
  const valueEditable = owned && row.price == null;

  const commit = (latest: Partial<{ shares: string; cost: string; value: string }> = {}) => {
    const sharesText = latest.shares ?? shares;
    const costText = latest.cost ?? cost;
    const valueText = latest.value ?? value;
    const parsedShares = sharesText.trim() === "" ? undefined : Math.max(0, Number(sharesText));
    const parsedCost = costText.trim() === "" ? undefined : Math.max(0, Number(costText));
    const parsedValue = valueText.trim() === "" ? undefined : Math.max(0, Number(valueText));
    updateHolding(portfolioId, row.ticker, {
      shares: Number.isFinite(parsedShares as number) ? parsedShares : undefined,
      costBasis: Number.isFinite(parsedCost as number) ? parsedCost : undefined,
      value: Number.isFinite(parsedValue as number) ? parsedValue : undefined,
    });
  };

  const weightStyle: WeightStyle = {
    "--holding-weight": `${Math.min(1, Math.max(0, row.weight)) * 100}%`,
  };

  const splitAdjustment = row.splitAdjustment;
  const showSplitNote = Boolean(splitAdjustment && !splitAdjustment.dismissedAt);

  return (
    <Fragment>
      <tr className="holding-row">
      <td>
        <button
          type="button"
          className="holding-ticker holding-ticker--button mono"
          onClick={() => onSelectTicker?.(row.ticker)}
          aria-label={`Inspect ${row.ticker} in this portfolio`}
        >
          {row.ticker}
        </button>
        {row.name && <span className="holding-name">{row.name}</span>}
        {splitAdjustment && (
          <span
            className="holding-split-badge"
            title={`Adjusted for a split — ${splitAdjustment.label}`}
          >
            split-adjusted
          </span>
        )}
      </td>
      <td className="num">
        {owned ? (
          <input
            className="cell-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            placeholder="0"
            value={shares}
            onChange={(event) => setShares(event.target.value)}
            onBlur={(event) => commit({ shares: event.currentTarget.value })}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            aria-label={`${row.ticker} shares`}
          />
        ) : row.shares != null ? (
          formatNumber(row.shares)
        ) : (
          "-"
        )}
      </td>
      <td className="num">
        {owned ? (
          <input
            className="cell-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            placeholder="-"
            value={cost}
            onChange={(event) => setCost(event.target.value)}
            onBlur={(event) => commit({ cost: event.currentTarget.value })}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            aria-label={`${row.ticker} average cost`}
          />
        ) : row.costBasis != null ? (
          formatPrice(row.costBasis)
        ) : (
          "-"
        )}
      </td>
      <td className="num">{row.price != null ? formatPrice(row.price) : "-"}</td>
      <td className="num">
        <DayCell row={row} />
      </td>
      <td className="num">
        {valueEditable ? (
          <input
            className="cell-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            placeholder="$ value"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onBlur={(event) => commit({ value: event.currentTarget.value })}
            onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
            aria-label={`${row.ticker} snapshot market value`}
          />
        ) : row.marketValue != null ? (
          formatCurrency(row.marketValue)
        ) : (
          "-"
        )}
      </td>
      <td className="num">
        <PerformanceValue row={row} />
      </td>
      <td className="num weight-cell">
        {row.weight > 0 ? (
          <>
            <span className="weight-cell__label">{formatPctPlain(row.weight)}</span>
            <span className="weight-bar" aria-hidden="true">
              <span className="weight-bar__fill" style={weightStyle} />
            </span>
          </>
        ) : (
          "-"
        )}
      </td>
      {owned && (
        <td className="num">
          <button
            type="button"
            className="icon-btn icon-btn--ghost"
            title={`Remove ${row.ticker}`}
            aria-label={`Remove ${row.ticker}`}
            onClick={() => removeFromPortfolio(portfolioId, row.ticker)}
          >
            <IconTrash size={14} />
          </button>
        </td>
      )}
      </tr>
      {showSplitNote && splitAdjustment && (
        <tr className="holding-split-note-row">
          <td colSpan={colSpan}>
            <SplitAdjustmentNote
              portfolioId={portfolioId}
              ticker={row.ticker}
              adjustment={splitAdjustment}
              compact
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function AddRow({ portfolioId, colSpan }: { portfolioId: string; colSpan: number }) {
  const addHoldingByTicker = useAppStore((s) => s.addHoldingByTicker);
  const [ticker, setTicker] = useState("");
  const [shares, setShares] = useState("");
  const [cost, setCost] = useState("");

  const submit = () => {
    if (!ticker.trim()) return;
    const ok = addHoldingByTicker(portfolioId, ticker, {
      shares: shares.trim() ? Math.max(0, Number(shares)) : undefined,
      costBasis: cost.trim() ? Math.max(0, Number(cost)) : undefined,
    });
    if (ok) {
      setTicker("");
      setShares("");
      setCost("");
    }
  };

  return (
    <tr className="add-row">
      <td>
        <input
          className="cell-input cell-input--ticker"
          placeholder="Ticker"
          value={ticker}
          onChange={(event) => setTicker(event.target.value.toUpperCase())}
          onKeyDown={(event) => event.key === "Enter" && submit()}
          aria-label="New holding ticker"
        />
      </td>
      <td className="num">
        <input
          className="cell-input"
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          placeholder="Shares"
          value={shares}
          onChange={(event) => setShares(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
          aria-label="New holding shares"
        />
      </td>
      <td className="num">
        <input
          className="cell-input"
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          placeholder="Avg cost"
          value={cost}
          onChange={(event) => setCost(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
          aria-label="New holding average cost"
        />
      </td>
      <td colSpan={colSpan - 4} />
      <td className="num">
        <button
          type="button"
          className="btn btn--ghost btn--sm holdings-add__button"
          onClick={submit}
          disabled={!ticker.trim()}
        >
          <IconPlus size={15} />
          Add
        </button>
      </td>
    </tr>
  );
}

export function HoldingsTable({
  rows,
  portfolioId,
  owned,
  onSelectTicker,
}: {
  rows: HoldingRow[];
  portfolioId: string;
  owned: boolean;
  onSelectTicker?: (ticker: string) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "weight", dir: "desc" });
  const columns = useMemo(() => COLUMNS.filter((c) => owned || !c.ownedOnly), [owned]);
  const colSpan = owned ? 9 : 8;

  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => compareRows(a, b, sort.key, sort.dir)),
    [rows, sort],
  );

  const onSort = (key: SortKey, numeric: boolean) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: numeric ? "desc" : "asc" },
    );
  };

  return (
    <div className="holdings-table-wrap">
      <table className="holdings-table">
        <caption className="sr-only">
          Portfolio holdings with sortable columns and editable shares, average cost, and snapshot value
          fields.
        </caption>
        <thead>
          <tr>
            {columns.map((col) => {
              const active = sort.key === col.key;
              return (
                <th
                  key={col.key}
                  scope="col"
                  className={col.numeric ? "num" : undefined}
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    className={`th-sort${active ? " is-active" : ""}`}
                    onClick={() => onSort(col.key, col.numeric)}
                  >
                    {col.label}
                    <span className="th-sort__icon" aria-hidden>
                      {active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </button>
                </th>
              );
            })}
            {owned && <th scope="col" className="num" aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => (
            <EditRow
              key={row.ticker}
              row={row}
              portfolioId={portfolioId}
              owned={owned}
              onSelectTicker={onSelectTicker}
              colSpan={colSpan}
            />
          ))}
          {owned && <AddRow portfolioId={portfolioId} colSpan={colSpan} />}
        </tbody>
      </table>
    </div>
  );
}
