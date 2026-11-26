import { describe, expect, it } from "vitest";
import {
  configurationId,
  LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
  ledgerSha256,
  ledgerSplitBlockers,
  validateLearningConfigLedger,
  validateLearningModelConfiguration,
  type LearningConfigLedger,
  type LearningModelConfiguration,
} from "@/engine/learningConfigLedger";

function ridgeConfig(lambda = 0.1): LearningModelConfiguration {
  return {
    schemaVersion: LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
    featureNames: ["momentum", "drawdown_own_vol_units"],
    hyperparameters: { family: "ridge_baseline", lambda },
    successThreshold: 0,
    probabilityCalibration: "isotonic",
    labelHorizonDays: 1,
  };
}

function gbmConfig(): LearningModelConfiguration {
  return {
    schemaVersion: LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
    featureNames: ["momentum", "drawdown_own_vol_units"],
    hyperparameters: {
      family: "gbm_challenger",
      rounds: 25,
      learningRate: 0.1,
      maxDepth: 2,
      minLeafSize: 5,
    },
    successThreshold: 0,
    probabilityCalibration: "isotonic",
    labelHorizonDays: 1,
  };
}

function ledger(entries?: LearningConfigLedger["entries"]): LearningConfigLedger {
  const ridge = ridgeConfig();
  const gbm = gbmConfig();
  return {
    schemaVersion: LEARNING_CONFIG_LEDGER_SCHEMA_VERSION,
    ledgerId: "ledger-2026-07-23-a",
    entries: entries ?? [
      {
        configurationId: configurationId(ridge),
        registeredAtISO: "2026-02-01T00:00:00.000Z",
        description: "Interpretable regularized baseline.",
        configuration: ridge,
        status: "registered",
      },
      {
        configurationId: configurationId(gbm),
        registeredAtISO: "2026-02-01T00:05:00.000Z",
        description: "Restrained nonlinear challenger.",
        configuration: gbm,
        status: "registered",
      },
    ],
  };
}

describe("configurationId — content-addressed identity", () => {
  it("is stable for identical configurations and differs when any field changes", () => {
    expect(configurationId(ridgeConfig())).toBe(configurationId(ridgeConfig()));
    expect(configurationId(ridgeConfig(0.1))).not.toBe(configurationId(ridgeConfig(0.2)));
    expect(configurationId(ridgeConfig())).toMatch(/^cfg:sha256:[0-9a-f]{64}$/);
  });

  it("rejects an unrestrained challenger depth", () => {
    const bad = {
      ...gbmConfig(),
      hyperparameters: { family: "gbm_challenger", rounds: 25, learningRate: 0.1, maxDepth: 6, minLeafSize: 5 },
    };
    expect(() => validateLearningModelConfiguration(bad)).toThrow(/maxDepth must be 1 or 2/);
  });

  it("rejects duplicate or empty feature names", () => {
    expect(() =>
      validateLearningModelConfiguration({ ...ridgeConfig(), featureNames: ["momentum", "momentum"] }),
    ).toThrow(/unique/);
    expect(() => validateLearningModelConfiguration({ ...ridgeConfig(), featureNames: [] })).toThrow(
      /non-empty/,
    );
  });
});

describe("validateLearningConfigLedger — append-only integrity", () => {
  it("accepts a chronological ledger with recomputable IDs and hashes deterministically", () => {
    const first = validateLearningConfigLedger(ledger());
    expect(ledgerSha256(first)).toBe(ledgerSha256(ledger()));
  });

  it("rejects an entry whose configurationId does not recompute", () => {
    const tampered = ledger();
    const entries = [...tampered.entries];
    entries[0] = { ...entries[0]!, configurationId: "cfg:sha256:" + "0".repeat(64) };
    expect(() => validateLearningConfigLedger({ ...tampered, entries })).toThrow(/does not recompute/);
  });

  it("rejects out-of-order registration (append-only violation)", () => {
    const bad = ledger();
    const entries = [...bad.entries].reverse();
    expect(() => validateLearningConfigLedger({ ...bad, entries })).toThrow(/append-only/);
  });

  it("rejects duplicate configurations", () => {
    const ridge = ridgeConfig();
    const entries = [
      {
        configurationId: configurationId(ridge),
        registeredAtISO: "2026-02-01T00:00:00.000Z",
        description: "first",
        configuration: ridge,
        status: "registered" as const,
      },
      {
        configurationId: configurationId(ridge),
        registeredAtISO: "2026-02-01T00:01:00.000Z",
        description: "second",
        configuration: ridge,
        status: "registered" as const,
      },
    ];
    expect(() => validateLearningConfigLedger(ledger(entries))).toThrow(/duplicates configuration/);
  });
});

describe("ledgerSplitBlockers — record-before-view enforcement", () => {
  const validated = validateLearningConfigLedger(ledger());
  const candidate = validated.entries[1]!.configurationId;
  const attempted = validated.entries.map((entry) => entry.configurationId);

  it("passes when the split exactly mirrors the ledger and selection is after registration", () => {
    expect(
      ledgerSplitBlockers(validated, {
        candidateId: candidate,
        modelSelectedAtISO: "2026-02-15T00:00:00.000Z",
        attemptedConfigurationIds: attempted,
      }),
    ).toEqual([]);
  });

  it("blocks an unregistered candidate", () => {
    const blockers = ledgerSplitBlockers(validated, {
      candidateId: "cfg:sha256:" + "f".repeat(64),
      modelSelectedAtISO: "2026-02-15T00:00:00.000Z",
      attemptedConfigurationIds: attempted,
    });
    expect(blockers).toContain(
      "Candidate configuration is not registered in the attempted-configuration ledger.",
    );
  });

  it("blocks a split that under-reports attempted configurations", () => {
    const blockers = ledgerSplitBlockers(validated, {
      candidateId: candidate,
      modelSelectedAtISO: "2026-02-15T00:00:00.000Z",
      attemptedConfigurationIds: [candidate],
    });
    expect(blockers).toContain(
      "Split attempted-configuration IDs do not exactly match the registered ledger.",
    );
  });

  it("blocks configurations registered after model selection", () => {
    const blockers = ledgerSplitBlockers(validated, {
      candidateId: candidate,
      modelSelectedAtISO: "2026-01-01T00:00:00.000Z",
      attemptedConfigurationIds: attempted,
    });
    expect(blockers.some((blocker) => blocker.includes("registered after model selection"))).toBe(true);
  });
});
