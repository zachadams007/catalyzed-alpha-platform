/** Heatmap feature icon - a subdivided treemap glyph, currentColor-driven. */
import type { IconProps } from "@/components/icons";

export function IconHeatmap({ size = 18, className, strokeWidth = 1.8 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2.4" />
      <path d="M3 13h11M14 3v18M14 9h7M3 17h11" />
    </svg>
  );
}
