import { useState, type MouseEvent } from "react";
import { Sparkline } from "@/components/common/Sparkline";
import { PriceChartModal } from "@/components/signal/PriceChartModal";
import type { StockSignal } from "@/types";

interface SparklineButtonProps {
  signal: StockSignal;
  width?: number;
  height?: number;
}

/** Clickable mini chart - opens an expanded view without leaving the feed. */
export function SparklineButton({ signal, width = 116, height = 40 }: SparklineButtonProps) {
  const [open, setOpen] = useState(false);

  const openChart = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        className="sparkline-btn"
        onClick={openChart}
        aria-label={`View ${signal.ticker} price chart`}
        title="View price chart"
      >
        <Sparkline data={signal.priceHistory} width={width} height={height} />
      </button>
      {open && <PriceChartModal signal={signal} onClose={() => setOpen(false)} />}
    </>
  );
}
