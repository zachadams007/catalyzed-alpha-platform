import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useGroupsStore } from "@/store/useGroupsStore";
import { relativeTime } from "@/lib/format";
import { IconTrash } from "@/components/icons";
import { IconChat } from "./icons";
import { GroupAvatar } from "./shared";
import type { GroupMessage } from "@/data/groups/types";
import type { PresenceMember } from "@/data/groups/groupsApi";

/** Day separator label for the transcript ("Today" / "Yesterday" / a date). */
function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Grouped {
  key: string;
  authorId: string;
  message: GroupMessage;
  showHeader: boolean; // first in a same-author streak
  dayBreak: string | null;
}

/** Collapse consecutive same-author messages and insert day breaks. */
function groupMessages(messages: GroupMessage[], now: number): Grouped[] {
  const out: Grouped[] = [];
  let prev: GroupMessage | null = null;
  let prevDay = "";
  for (const m of messages) {
    const day = dayLabel(m.createdAt, now);
    const dayBreak = day !== prevDay ? day : null;
    const sameStreak =
      prev != null &&
      prev.author.id === m.author.id &&
      dayBreak == null &&
      new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60 * 1000;
    out.push({ key: m.id, authorId: m.author.id, message: m, showHeader: !sameStreak, dayBreak });
    prev = m;
    prevDay = day;
  }
  return out;
}

/** Members-only, realtime group chat. Streams new lines over Supabase Realtime. */
export function GroupChat({ currentUserId, isAdmin }: { currentUserId: string | null; isAdmin: boolean }) {
  const messages = useGroupsStore((s) => s.messages);
  const sendMessage = useGroupsStore((s) => s.sendMessage);
  const removeMessage = useGroupsStore((s) => s.removeMessage);
  const onlineInGroup = useGroupsStore((s) => s.onlineInGroup);
  const setTypingInGroup = useGroupsStore((s) => s.setTypingInGroup);

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const now = Date.now();

  // Others who are currently typing (exclude self).
  const typingOthers: PresenceMember[] = onlineInGroup.filter(
    (m) => m.userId !== currentUserId && m.typing,
  );
  const typingLabel =
    typingOthers.length === 1
      ? `${typingOthers[0].name} is typing…`
      : typingOthers.length > 1
        ? "Several people are typing…"
        : null;

  // Online count excluding self.
  const onlineCount = onlineInGroup.filter((m) => m.userId !== currentUserId).length;

  const grouped = useMemo(() => groupMessages(messages, now), [messages, now]);

  // Track whether the user is pinned to the bottom (so a new line auto-scrolls
  // only when they're already there - never yank them up mid-scrollback).
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // First mount: jump to the latest message instantly (no animated scroll).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setErr(null);
    atBottomRef.current = true; // sending implies you want to see your line
    const r = await sendMessage(text);
    setBusy(false);
    if (r.ok) setDraft("");
    else setErr(r.error ?? "Couldn't send.");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const onInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const hasText = (e.currentTarget.value ?? "").trim().length > 0;
    setTypingInGroup(hasText);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (hasText) {
      typingTimerRef.current = setTimeout(() => {
        setTypingInGroup(false);
      }, 1500);
    }
  };

  // Clear typing on unmount.
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      setTypingInGroup(false);
    };
  }, [setTypingInGroup]);

  return (
    <section className="grp-panel grp-chat" aria-labelledby="grp-chat-title">
      <header className="grp-panel__head">
        <div className="grp-panel__title" id="grp-chat-title">
          <IconChat size={17} />
          <span>Chat</span>
          {messages.length > 0 && <span className="grp-panel__count mono">{messages.length}</span>}
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: "var(--sp-3)" }}>
          {onlineCount > 0 && (
            <span className="grp-chat__presence" title={`${onlineCount} other member${onlineCount === 1 ? "" : "s"} viewing`}>
              <span className="grp-chat__presence-dot" aria-hidden="true" />
              {onlineCount} online
            </span>
          )}
          <span className="grp-chat__live" title="New messages appear instantly">
            <span className="grp-chat__livedot" aria-hidden="true" /> Live
          </span>
        </div>
      </header>

      <div className="grp-chat__scroll" ref={scrollRef} onScroll={onScroll} role="log" aria-live="polite">
        {grouped.length === 0 ? (
          <div className="empty grp-empty grp-chat__empty">
            <IconChat size={24} />
            <p>No messages yet. Say hello — start the conversation about what your group is watching.</p>
          </div>
        ) : (
          <ul className="grp-chat__list">
            {grouped.map((g) => {
              const m = g.message;
              const mine = m.author.id === currentUserId;
              const canDelete = isAdmin || mine;
              return (
                <li key={g.key}>
                  {g.dayBreak && (
                    <div className="grp-chat__day" role="separator">
                      <span>{g.dayBreak}</span>
                    </div>
                  )}
                  <div
                    className={`grp-msg ${mine ? "grp-msg--mine" : ""} ${g.showHeader ? "" : "grp-msg--cont"}`}
                  >
                    <div className="grp-msg__gutter">
                      {g.showHeader ? (
                        <GroupAvatar profile={m.author} size={30} />
                      ) : (
                        <span className="grp-msg__time-hover mono" aria-hidden="true">
                          {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                        </span>
                      )}
                    </div>
                    <div className="grp-msg__body">
                      {g.showHeader && (
                        <div className="grp-msg__head">
                          <span className="grp-msg__author">
                            {m.author.displayName || m.author.handle || "Member"}
                          </span>
                          <span className="grp-msg__time text-faint">{relativeTime(m.createdAt, now)}</span>
                        </div>
                      )}
                      <p className="grp-msg__text">{m.body}</p>
                    </div>
                    {canDelete && (
                      <button
                        className="grp-iconbtn grp-iconbtn--danger grp-msg__del"
                        onClick={() => void removeMessage(m.id)}
                        title="Delete message"
                        aria-label="Delete message"
                      >
                        <IconTrash size={13} />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="grp-chat__typing" aria-live="polite" aria-atomic="true">
        {typingLabel ?? ""}
      </div>

      <div className="grp-chat__composer">
        <textarea
          className="grp-chat__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onInput={onInput}
          placeholder="Message your group…"
          aria-label="Write a message"
          rows={1}
          maxLength={2000}
        />
        <button
          className="btn btn--primary btn--sm grp-chat__send"
          onClick={() => void send()}
          disabled={busy || !draft.trim()}
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
      {err && <p className="grp-form__error" role="alert">{err}</p>}
    </section>
  );
}
