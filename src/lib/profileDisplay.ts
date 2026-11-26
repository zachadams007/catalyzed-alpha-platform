export { getAvatar, setAvatar, removeAvatar, compressImageFile } from "@/lib/avatarStore";

const AVATAR_ACCENTS = ["#3f5fc9", "#6741a8", "#3cb88a", "#d9a04a", "#e85d6f", "#2a9d8f", "#e76f51"];

/** Two-letter initials from a display name or handle (e.g. "The owner Adams" → "ZA"). */
export function initialsFromLabel(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) return "??";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
  }
  const clean = trimmed.replace(/[^a-zA-Z0-9]/g, "");
  return (clean.slice(0, 2) || "??").toUpperCase();
}

export function avatarAccentFromLabel(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0;
  return AVATAR_ACCENTS[h % AVATAR_ACCENTS.length]!;
}
