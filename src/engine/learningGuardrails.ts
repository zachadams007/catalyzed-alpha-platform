import { round } from "@/lib/math";

/** Small, dependency-free drift checks for a future server-side learner. */
export interface DriftAssessment {
  modelAgeDays: number | null;
  featureCoverageDrop: number | null;
  populationStabilityIndex: number | null;
  stale: boolean;
  drifted: boolean;
  /** True whenever evidence is missing or a stale/drift threshold is breached. */
  blocked: boolean;
  reasons: string[];
}
export interface DriftInput {
  trainedAtISO?: string;
  nowISO: string;
  baselineFeatureCoverage?: number;
  currentFeatureCoverage?: number;
  /** Numeric feature distributions sampled before and after deployment. */
  baselineValues?: readonly number[];
  currentValues?: readonly number[];
  /** Fixed, versioned bin edges. Do not derive bins after observing current data. */
  binEdges?: readonly number[];
}

const EPSILON = 1e-6;

function parseISO(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Population Stability Index using pre-registered bin edges. It reports a
 * distribution shift; it does not explain its cause or prove model decay.
 */
export function populationStabilityIndex(
  baseline: readonly number[],
  current: readonly number[],
  binEdges: readonly number[],
): number | null {
  if (baseline.length === 0 || current.length === 0 || binEdges.length < 2) return null;
  if (binEdges.some((edge, index) => !Number.isFinite(edge) || (index > 0 && edge <= binEdges[index - 1]!))) {
    throw new Error("binEdges must be finite and strictly increasing.");
  }
  const count = (values: readonly number[]) => {
    const bins = new Array(binEdges.length - 1).fill(0);
    for (const value of values) {
      if (!Number.isFinite(value)) continue;
      let index = binEdges.length - 2;
      for (let i = 0; i < binEdges.length - 1; i++) {
        if (value <= binEdges[i + 1]!) {
          index = i;
          break;
        }
      }
      bins[index] += 1;
    }
    return bins;
  };
  const baseBins = count(baseline);
  const currentBins = count(current);
  const baseTotal = baseBins.reduce((sum, value) => sum + value, 0);
  const currentTotal = currentBins.reduce((sum, value) => sum + value, 0);
  if (baseTotal === 0 || currentTotal === 0) return null;

  const psi = baseBins.reduce((sum, baseCount, index) => {
    const expected = Math.max(baseCount / baseTotal, EPSILON);
    const actual = Math.max(currentBins[index]! / currentTotal, EPSILON);
    return sum + (actual - expected) * Math.log(actual / expected);
  }, 0);
  return round(psi, 5);
}

/**
 * Block a stale or shifted candidate before it can be reviewed. This is a
 * fail-closed guard: callers still need independent walk-forward, calibration,
 * coverage, concentration, and stability evidence before any manual promotion.
 */
export function assessLearningDrift(input: DriftInput): DriftAssessment {
  const reasons: string[] = [];
  const trainedMs = parseISO(input.trainedAtISO);
  const nowMs = parseISO(input.nowISO);
  const modelAgeDays =
    trainedMs != null && nowMs != null && nowMs >= trainedMs
      ? round((nowMs - trainedMs) / 86_400_000, 2)
      : null;
  const coverageValuesProvided =
    input.baselineFeatureCoverage != null || input.currentFeatureCoverage != null;
  const coverageEvidenceValid =
    input.baselineFeatureCoverage != null &&
    input.currentFeatureCoverage != null &&
    Number.isFinite(input.baselineFeatureCoverage) &&
    Number.isFinite(input.currentFeatureCoverage) &&
    input.baselineFeatureCoverage >= 0 &&
    input.baselineFeatureCoverage <= 1 &&
    input.currentFeatureCoverage >= 0 &&
    input.currentFeatureCoverage <= 1;
  const featureCoverageDrop =
    coverageEvidenceValid
      ? round(input.baselineFeatureCoverage! - input.currentFeatureCoverage!, 4)
      : null;
  const psi =
    input.baselineValues && input.currentValues && input.binEdges
      ? populationStabilityIndex(input.baselineValues, input.currentValues, input.binEdges)
      : null;
  const stale = modelAgeDays != null && modelAgeDays > 30;
  const invalidTemporalOrder = trainedMs != null && nowMs != null && trainedMs > nowMs;
  const drifted =
    invalidTemporalOrder ||
    (featureCoverageDrop != null && featureCoverageDrop > 0.1) ||
    (psi != null && psi >= 0.25);

  if (trainedMs == null) reasons.push("No valid training timestamp.");
  if (nowMs == null) reasons.push("No valid evaluation timestamp.");
  if (invalidTemporalOrder) reasons.push("Training timestamp is after the evaluation timestamp.");
  if (stale) reasons.push(`Model is ${modelAgeDays} days old (maximum review age is 30 days).`);
  if (coverageValuesProvided && !coverageEvidenceValid) {
    reasons.push("Feature coverage values must both be finite numbers between 0 and 1.");
  } else if (featureCoverageDrop == null) {
    reasons.push("No comparable feature-coverage evidence was available.");
  }
  if (featureCoverageDrop != null && featureCoverageDrop > 0.1) {
    reasons.push(`Feature coverage dropped ${(featureCoverageDrop * 100).toFixed(1)} percentage points.`);
  }
  if (psi != null && psi >= 0.25) reasons.push(`Feature-distribution PSI is ${psi} (>= 0.25).`);
  if (psi == null) reasons.push("No comparable feature-distribution PSI was available.");

  const missingRequiredEvidence = trainedMs == null || nowMs == null || featureCoverageDrop == null || psi == null;
  const blocked = missingRequiredEvidence || stale || drifted;

  return { modelAgeDays, featureCoverageDrop, populationStabilityIndex: psi, stale, drifted, blocked, reasons };
}
