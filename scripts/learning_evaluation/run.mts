import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  runOfflineLearningEvaluation,
  type OfflineLearningBundle,
} from "./offlineLearningRunner";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBundle(value: unknown): OfflineLearningBundle {
  if (!record(value)) throw new Error("Offline-learning input must be a JSON object.");
  return value as unknown as OfflineLearningBundle;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    throw new Error(
      "Usage: npm run learning:evaluate -- <input-bundle.json> <output-report.json>",
    );
  }

  const input = parseBundle(JSON.parse(await readFile(resolve(inputPath), "utf8")));
  const report = runOfflineLearningEvaluation(input);
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Offline learning verdict: ${report.verdict.status}; report: ${resolve(outputPath)}\n`,
  );
  if (report.verdict.status === "blocked") process.exitCode = 2;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
