import { useState } from "react";
import { Modal } from "@/components/common/Modal";
import { useAppStore } from "@/store/useAppStore";
import { IconCopy, IconCheck } from "@/components/icons";
import { inviteLink } from "./invite";

/**
 * Share sheet for a group's invite link. One link onboards a whole group chat -
 * paste it in and everyone taps in. Falls back to the raw code for manual copy.
 */
export function InviteModal({
  token,
  groupName,
  onClose,
}: {
  token: string;
  groupName: string;
  onClose: () => void;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const link = inviteLink(token);
  const [copied, setCopied] = useState<"link" | "code" | null>(null);

  const copy = async (text: string, which: "link" | "code") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      pushToast("Copied to clipboard", "success");
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1800);
    } catch {
      pushToast("Couldn't copy — select and copy manually.", "warn");
    }
  };

  return (
    <Modal title={`Invite to ${groupName}`} onClose={onClose} className="grp-invite-modal">
      <p className="text-muted grp-invite__lede">
        Send this link to your group chat. Anyone with it can join — no 1:1 adds.
      </p>

      <label className="grp-invite__label">Invite link</label>
      <div className="grp-invite__row">
        <input className="grp-invite__field mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
        <button className="btn btn--primary btn--sm" onClick={() => void copy(link, "link")}>
          {copied === "link" ? <IconCheck size={14} /> : <IconCopy size={14} />} {copied === "link" ? "Copied" : "Copy"}
        </button>
      </div>

      <label className="grp-invite__label">Or share the code</label>
      <div className="grp-invite__row">
        <input className="grp-invite__field mono" readOnly value={token} onFocus={(e) => e.currentTarget.select()} aria-label="Invite code" />
        <button className="btn btn--ghost btn--sm" onClick={() => void copy(token, "code")}>
          {copied === "code" ? <IconCheck size={14} /> : <IconCopy size={14} />} {copied === "code" ? "Copied" : "Copy"}
        </button>
      </div>

      <p className="text-faint grp-invite__note">
        Recipients open the link, sign in (or create a free account), and they're in. The link keeps working until you turn it off.
      </p>
    </Modal>
  );
}
