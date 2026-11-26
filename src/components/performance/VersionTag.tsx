import { VARIANT_VERSION_TAGS, type EngineVariantId } from "@/engine/challenger";

/**
 * The small "which engine made this call" badge on a Track Record row.
 *
 * Honest by construction: a pick recorded before the ledger stamped its engine
 * version reads "untagged" - never a guessed version. The tag itself comes from
 * the single {@link VARIANT_VERSION_TAGS} map so the badge can never drift from
 * the registry.
 */
export function VersionTag({ variant, className = "" }: { variant?: EngineVariantId; className?: string }) {
  const tagged = variant != null;
  const label = tagged ? VARIANT_VERSION_TAGS[variant] : "untagged";
  const title = tagged
    ? `Picked by engine ${label}`
    : "Picked before engine versions were recorded on the ledger";
  return (
    <span
      className={`pill pill--version${tagged ? ` pill--version-${variant}` : " pill--version-untagged"} ${className}`.trim()}
      title={title}
      aria-label={title}
    >
      {label}
    </span>
  );
}
