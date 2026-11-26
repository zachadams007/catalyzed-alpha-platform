import { ENGINE_LINEAGE, lineageIdForVariant } from "@/viz/pipelineModel";
import { useActiveVariant } from "@/hooks/useActiveVariant";

/**
 * Compact v1 → v2 → v3 → v4 → v5 engine lineage with the LIVE version flagged and the
 * forward CHALLENGER candidate marked "TESTING". Shown on the Operator (Engine
 * registry) and the Track Record / Model Lab so it is unmistakable which engine is
 * live and which is being measured to replace it. The live id is DERIVED from the
 * resolved active variant at render time (never hardcoded, never the module-load
 * snapshot), so the badge can't claim the wrong model is running (CLAUDE.md
 * fidelity rule).
 */
export function EngineLineageStrip() {
  const liveId = lineageIdForVariant(useActiveVariant());
  // The forward candidate is the newest registered version that isn't live. Once
  // the newest is promoted there is no candidate.
  const newestId = ENGINE_LINEAGE[ENGINE_LINEAGE.length - 1]!.id;
  const candidateId: string | null = liveId === newestId ? null : newestId;
  const liveVersion = ENGINE_LINEAGE.find((v) => v.id === liveId);
  const candidateVersion = ENGINE_LINEAGE.find((v) => v.id === candidateId);

  return (
    <div className="engine-lineage" role="group" aria-label="Engine version lineage">
      <div className="engine-lineage__track">
        {ENGINE_LINEAGE.map((v, i) => {
          const isLive = v.id === liveId;
          const isCandidate = v.id === candidateId;
          return (
            <div key={v.id} className="engine-lineage__step">
              <span
                className={`engine-lineage__chip mono${
                  isLive ? " engine-lineage__chip--live" : ""
                }${isCandidate ? " engine-lineage__chip--candidate" : ""}`}
                title={`${v.name} — ${v.summary}`}
              >
                {v.id.toUpperCase()}
                {isLive ? <span className="engine-lineage__live">LIVE</span> : null}
                {isCandidate ? <span className="engine-lineage__cand">TESTING</span> : null}
              </span>
              {i < ENGINE_LINEAGE.length - 1 ? (
                <span className="engine-lineage__arrow" aria-hidden="true">
                  →
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      {liveVersion ? (
        <p className="engine-lineage__cap">
          Live engine <strong className="mono">{liveId?.toUpperCase()}</strong> · {liveVersion.name}
          {candidateVersion ? (
            <>
              {" · challenger "}
              <strong className="mono">{candidateId?.toUpperCase()}</strong> in testing
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
