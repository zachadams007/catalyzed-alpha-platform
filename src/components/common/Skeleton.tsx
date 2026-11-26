import type { CSSProperties } from "react";

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}

/** Shimmering placeholder block used while live data loads. */
export function Skeleton({ width, height = 14, radius = 8, className, style }: SkeletonProps) {
  return (
    <span
      className={className ? `skeleton ${className}` : "skeleton"}
      style={{ width, height, borderRadius: radius, ...style }}
      aria-hidden
    />
  );
}
