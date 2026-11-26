import type { IconProps } from "@/components/icons";

/**
 * Groups-local icons (the shared icon set is owned by another lane, so we keep
 * Groups' glyphs here). Feather-style, currentColor-driven, matching the app set.
 */

function Svg({ size = 18, className, strokeWidth = 1.8, children }: IconProps & { children: React.ReactNode }) {
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
      {children}
    </svg>
  );
}

/** Three people - a group (distinct from Friends' two). */
export const IconGroups = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="7.2" r="2.7" />
    <path d="M6.8 18a5.2 5.2 0 0 1 10.4 0" />
    <circle cx="4.7" cy="9.6" r="2" />
    <path d="M2 17a3.7 3.7 0 0 1 2.9-3.6" />
    <circle cx="19.3" cy="9.6" r="2" />
    <path d="M22 17a3.7 3.7 0 0 0-2.9-3.6" />
  </Svg>
);

/** Trophy for the leaderboard. */
export const IconTrophy = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4h10v4a5 5 0 0 1-10 0V4z" />
    <path d="M7 6H4.5a2.5 2.5 0 0 0 2.5 4M17 6h2.5a2.5 2.5 0 0 1-2.5 4" />
    <path d="M12 13v3M9 20h6M10 20a2 2 0 0 1 4 0" />
  </Svg>
);

/** Megaphone - log a call. */
export const IconMegaphone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 10v4a1 1 0 0 0 1 1h2l8 4V5L7 9H5a1 1 0 0 0-1 1z" />
    <path d="M18 8a4 4 0 0 1 0 8" />
  </Svg>
);

/** Link - invite. */
export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 13a4 4 0 0 0 5.7.4l3-3A4 4 0 0 0 12 4.7l-1.5 1.5" />
    <path d="M15 11a4 4 0 0 0-5.7-.4l-3 3A4 4 0 0 0 12 19.3l1.5-1.5" />
  </Svg>
);

/** Speech bubble - chat. */
export const IconChat = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 11.5a8.5 7.5 0 0 1-12 6.8L3 20l1.5-4.2A8.5 7.5 0 1 1 21 11.5z" />
    <path d="M8.5 11h7M8.5 8h5" />
  </Svg>
);

/** Bars - a poll. */
export const IconPoll = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 20V10M12 20V4M18 20v-6" />
    <path d="M3 20h18" />
  </Svg>
);

/** Bell - activity / alerts. */
export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 8a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 14 18 8z" />
    <path d="M10.3 19a2 2 0 0 0 3.4 0" />
  </Svg>
);

/** Plus inside a circle - add option. */
export const IconPlusCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8.5v7M8.5 12h7" />
  </Svg>
);
