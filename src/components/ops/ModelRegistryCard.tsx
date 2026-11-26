import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { Modal } from "@/components/common/Modal";
import { relativeTime } from "@/lib/format";
import { compareModels } from "@/engine/outcomeEval";
import { currentChampion, type ModelRegistryEntry } from "@/engine/modelRegistry";
import { EngineLineageStrip } from "@/components/ops/EngineLineageStrip";
import { IconTarget } from "@/components/icons";

/**
 * Operator control for the champion/challenger loop - the model registry +
 * changelog, with one-click promote / rollback and the live promotion read.
 * The feed never moves on its own: it changes only when the operator deliberately
 * promotes here. Promotion is GLOBAL and app-wide - it writes the active model to
 * the server-side controls, so the promoted model goes live for EVERY user (web,
 * phone, desktop), not just this device, and takes effect immediately.
 */
export function ModelRegistryCard() {
  const registry = useAppStore((s) => s.modelRegistry);
  const ledger = useAppStore((s) => s.outcomeLedger);
  const promoteModel = useAppStore((s) => s.promoteModel);
  const rollbackModel = useAppStore((s) => s.rollbackModel);

  const comparison = useMemo(() => compareModels(ledger, "d30"), [ledger]);
  const champion = currentChampion(registry);
  const [confirm, setConfirm] = useState<{ entry: ModelRegistryEntry; isRollback: boolean } | null>(
    null,
  );

  const deltaSign = comparison.deltaIC >= 0 ? "+" : "";

  return (
    <div className="ops-card">
      <div className="ops-card__title">Engine registry</div>
      <p className="ops-card__sub">
        Champion / challenger changelog. Promotion is a deliberate operator action — the live feed
        never moves on its own. Promoting is <strong>global</strong>: the champion goes live for
        every user (web, phone &amp; desktop) immediately, not just this device — Today, This Week
        and For You re-rank at once, and every future scan uses it. Both engines always sweep the
        identical full universe (whole US market); they differ only by algorithm.
      </p>

      <EngineLineageStrip />

      <div className="model-eval" role="group" aria-label="Challenger measurement (30-day)">
        <span className={`model-eval__badge${comparison.promote ? " model-eval__badge--ready" : ""}`}>
          {comparison.promote ? "Challenger ready" : "Directional"}
        </span>
        <span className="model-eval__metric">
          ΔIC <span className="mono">{deltaSign}{comparison.deltaIC.toFixed(4)}</span>
        </span>
        <span className="model-eval__metric">
          win rate <span className="mono">{Math.round(comparison.winRate * 100)}%</span>
        </span>
        <span className="model-eval__metric">
          cohorts <span className="mono">{comparison.cohorts}</span>
        </span>
      </div>
      <p className="model-eval__note">
        {comparison.rationale}{" "}
        <Link to="/performance" className="model-eval__link">
          <IconTarget size={12} /> See the leaderboard
        </Link>
      </p>

      <ul className="model-list">
        {registry.entries.map((e) => {
          const isLive = e.id === registry.championId;
          // Promote vs roll back is decided by VERSION RECENCY, not the slot name:
          // promoting a NEWER candidate (e.g. V5 over the live V4) is a forward
          // promotion; switching to an OLDER version is a rollback. Keeps the label
          // truthful no matter which engine sits in which slot.
          const championCreated = champion ? new Date(champion.createdAtISO).getTime() : 0;
          const isRollback = !isLive && new Date(e.createdAtISO).getTime() < championCreated;
          return (
            <li key={e.id} className={`model-row${isLive ? " model-row--live" : ""}`}>
              <div className="model-row__head">
                <span className={`model-kind model-kind--${e.kind}`}>{e.kind}</span>
                <span className="model-row__label">{e.label}</span>
                {isLive ? <span className="model-row__livetag">LIVE</span> : null}
              </div>
              <p className="model-row__summary">{e.changeSummary}</p>
              <div className="model-row__meta">
                <span>registered {relativeTime(e.createdAtISO)}</span>
                {e.promotedAtISO ? (
                  <span>
                    {" · "}last promoted {relativeTime(e.promotedAtISO)}
                    {e.promotedBy ? ` by ${e.promotedBy}` : ""}
                  </span>
                ) : null}
              </div>
              {!isLive ? (
                <button
                  className={`btn btn--sm ${isRollback ? "btn--ghost" : "btn--primary"}`}
                  onClick={() => setConfirm({ entry: e, isRollback })}
                >
                  {isRollback ? "Roll back to this" : "Promote to champion"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {confirm ? (
        <Modal
          title={confirm.isRollback ? "Roll back the champion?" : "Promote to champion?"}
          onClose={() => setConfirm(null)}
          footer={
            <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn btn--primary btn--sm"
                onClick={() => {
                  if (confirm.isRollback) rollbackModel(confirm.entry.id);
                  else promoteModel(confirm.entry.id);
                  setConfirm(null);
                }}
              >
                {confirm.isRollback ? "Roll back" : "Promote"}
              </button>
            </div>
          }
        >
          <p className="text-muted" style={{ fontSize: 13.5, lineHeight: 1.6 }}>
            The engine will run as <strong>{confirm.entry.kind}</strong> (&ldquo;{confirm.entry.label}
            &rdquo;) <strong>for every user, immediately</strong> — this sets the active model
            app-wide (web, phone &amp; desktop), not just on your device. Today, This Week and For You
            re-rank the moment you confirm, and every future scan uses it too. The current champion
            was <strong>{champion?.label}</strong>. Both engines scan the identical full universe
            (whole US market) — only the algorithm changes. You can reverse this anytime from this
            registry; nothing about past recorded outcomes changes.
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
