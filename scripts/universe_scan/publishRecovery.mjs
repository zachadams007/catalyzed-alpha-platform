import { isAbsolute, relative, resolve, sep } from "node:path";

export function easternDayKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function validateSavedScanForPublish(
  run,
  meta,
  { now = new Date(), expectedSourceRunId, minimumStartedAtISO } = {},
) {
  const finishedAtMs = Date.parse(run?.finishedAt ?? "");
  if (
    !Number.isFinite(finishedAtMs) ||
    finishedAtMs > now.getTime() + 5 * 60_000 ||
    now.getTime() - finishedAtMs > 36 * 60 * 60_000
  ) {
    throw new Error("Refusing to publish a stale or invalid last-scan.json.");
  }
  if (expectedSourceRunId && meta?.learningArchive?.sourceRunId !== expectedSourceRunId) {
    throw new Error("Refusing to publish last-scan.json from a different scan attempt.");
  }
  if (minimumStartedAtISO) {
    const minimumStartedAtMs = Date.parse(minimumStartedAtISO);
    const runStartedAtMs = Date.parse(run?.startedAt ?? "");
    if (
      !Number.isFinite(minimumStartedAtMs) ||
      !Number.isFinite(runStartedAtMs) ||
      runStartedAtMs < minimumStartedAtMs
    ) {
      throw new Error("Refusing to publish last-scan.json from before this wrapper invocation.");
    }
  }
  if (easternDayKey(new Date(finishedAtMs)) !== easternDayKey(now)) {
    throw new Error("Refusing to publish last-scan.json from a different US/Eastern day.");
  }
  return finishedAtMs;
}

export function resolveArchiveReference(archiveRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw new Error("Learning-universe archive reference is empty.");
  }
  if (isAbsolute(relativePath)) {
    throw new Error("Learning-universe archive reference must be relative.");
  }
  const root = resolve(archiveRoot);
  const artifactPath = resolve(root, relativePath);
  const escape = relative(root, artifactPath);
  if (
    isAbsolute(escape) ||
    escape === "" ||
    escape === ".." ||
    escape.startsWith(`..${sep}`)
  ) {
    throw new Error("Learning-universe archive path escapes the configured archive root.");
  }
  return artifactPath;
}
