/**
 * Tiny localStorage-backed avatar store.
 * Keyed by userId (when signed in) or "local" (when not configured / no user).
 * Images are stored as data-URL strings, downscaled to <=256px before saving.
 */

const STORAGE_PREFIX = "catalyzed-avatar:";

function storageKey(userId: string | null): string {
  return STORAGE_PREFIX + (userId ?? "local");
}

/** Read the stored avatar data-URL for a user (or null if none). */
export function getAvatar(userId: string | null): string | null {
  try {
    return localStorage.getItem(storageKey(userId));
  } catch {
    return null;
  }
}

/** Persist an avatar data-URL for a user. */
export function setAvatar(userId: string | null, dataUrl: string): void {
  try {
    localStorage.setItem(storageKey(userId), dataUrl);
  } catch (e) {
    console.warn("avatarStore: could not save avatar", e);
  }
}

/** Remove the stored avatar for a user, reverting to initials. */
export function removeAvatar(userId: string | null): void {
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // ignore
  }
}

/** Max dimension (px) to downscale avatar to before storing. */
const MAX_PX = 256;

/**
 * Given a File from <input type="file">, downscale it to MAX_PX × MAX_PX
 * (preserving aspect ratio) via a canvas and return a JPEG data-URL.
 */
export function compressImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const src = ev.target?.result;
      if (typeof src !== "string") {
        reject(new Error("FileReader did not return a string"));
        return;
      }
      const img = new Image();
      img.onload = () => {
        const { width, height } = img;
        const scale = Math.min(1, MAX_PX / Math.max(width, height));
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Canvas 2D context unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => reject(new Error("Image failed to load"));
      img.src = src;
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
  });
}
