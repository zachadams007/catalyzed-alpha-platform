import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useGroupsStore } from "@/store/useGroupsStore";
import { relativeTime } from "@/lib/format";
import { resolveSymbol } from "@/data/symbols/symbolDirectory";
import { isPollOpen, leadingOptionIds, optionShare, sortPolls } from "@/data/groups/polls";
import { IconCheck, IconTrash, IconPlus } from "@/components/icons";
import { IconPoll, IconPlusCircle } from "./icons";
import { GroupAvatar } from "./shared";
import type { GroupPoll, PollOption, PollOptionDraft } from "@/data/groups/types";

const MAX_OPTIONS = 8;

/** Percentage label for a tally bar; " - " when there are no votes yet. */
function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function PollCard({
  poll,
  currentUserId,
  isAdmin,
  now,
}: {
  poll: GroupPoll;
  currentUserId: string | null;
  isAdmin: boolean;
  now: number;
}) {
  const vote = useGroupsStore((s) => s.vote);
  const closePoll = useGroupsStore((s) => s.closePoll);
  const removePoll = useGroupsStore((s) => s.removePoll);
  const [err, setErr] = useState<string | null>(null);

  const open = isPollOpen(poll, now);
  const leaders = useMemo(() => leadingOptionIds(poll.options), [poll.options]);
  const canManage = isAdmin || poll.author.id === currentUserId;
  // Show the breakdown once the viewer has voted or the poll has closed.
  const revealed = !open || poll.myVote != null;

  const onVote = async (optionId: string) => {
    if (!open) return;
    setErr(null);
    const r = await vote(poll.id, optionId);
    if (!r.ok) setErr(r.error ?? "Couldn't record your vote.");
  };

  return (
    <li className={`grp-poll ${open ? "" : "grp-poll--closed"}`}>
      <div className="grp-poll__head">
        <div className="grp-poll__q">
          <span className={`grp-poll__state ${open ? "grp-poll__state--open" : "grp-poll__state--closed"}`}>
            {open ? "Open" : "Closed"}
          </span>
          <h4>{poll.question}</h4>
        </div>
        {canManage && (
          <div className="grp-poll__manage">
            {open && (
              <button className="grp-textbtn" onClick={() => void closePoll(poll.id)} title="End voting">
                Close
              </button>
            )}
            <button
              className="grp-iconbtn grp-iconbtn--danger"
              onClick={() => void removePoll(poll.id)}
              title="Delete poll"
              aria-label="Delete poll"
            >
              <IconTrash size={13} />
            </button>
          </div>
        )}
      </div>

      <ul className="grp-poll__opts">
        {poll.options.map((o: PollOption) => {
          const share = optionShare(o, poll.totalVotes);
          const mine = poll.myVote === o.id;
          const leading = revealed && poll.totalVotes > 0 && leaders.includes(o.id);
          return (
            <li key={o.id}>
              <button
                type="button"
                className={`grp-opt ${mine ? "grp-opt--mine" : ""} ${leading ? "grp-opt--lead" : ""} ${open ? "grp-opt--votable" : ""}`}
                onClick={() => void onVote(o.id)}
                disabled={!open}
                aria-pressed={mine}
              >
                <span
                  className="grp-opt__fill"
                  style={{ width: revealed ? `${Math.max(share * 100, 2)}%` : "0%" }}
                  aria-hidden="true"
                />
                <span className="grp-opt__face">
                  <span className="grp-opt__label">
                    {mine && <IconCheck size={13} className="grp-opt__check" />}
                    {o.ticker ? (
                      <Link to={`/signal/${o.ticker}`} className="ticker mono grp-opt__ticker" onClick={(e) => e.stopPropagation()}>
                        {o.ticker}
                      </Link>
                    ) : null}
                    <span className="grp-opt__text">{o.ticker && o.label === o.ticker ? "" : o.label}</span>
                  </span>
                  {revealed && (
                    <span className="grp-opt__tally mono">
                      <span className="grp-opt__pct">{pct(share)}</span>
                      <span className="grp-opt__count text-faint">
                        {o.votes} vote{o.votes === 1 ? "" : "s"}
                      </span>
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="grp-poll__foot">
        <GroupAvatar profile={poll.author} size={20} />
        <span className="text-faint">
          {poll.author.displayName || poll.author.handle || "Member"} · {relativeTime(poll.createdAt, now)}
          {" · "}
          {poll.totalVotes} vote{poll.totalVotes === 1 ? "" : "s"}
        </span>
        {open && poll.myVote == null && <span className="grp-poll__hint">Tap an option to vote</span>}
      </div>
      {err && <p className="grp-form__error" role="alert">{err}</p>}
    </li>
  );
}

/** Create-poll composer + the list of polls with live tallies. */
export function GroupPolls({ currentUserId, isAdmin }: { currentUserId: string | null; isAdmin: boolean }) {
  const polls = useGroupsStore((s) => s.polls);
  const createPoll = useGroupsStore((s) => s.createPoll);

  const [composing, setComposing] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const now = Date.now();
  const ordered = useMemo(() => sortPolls(polls, now), [polls, now]);

  const setOption = (i: number, v: string) =>
    setOptions((prev) => prev.map((o, idx) => (idx === i ? v.toUpperCase().slice(0, 80) : o)));
  const addOption = () => setOptions((prev) => (prev.length < MAX_OPTIONS ? [...prev, ""] : prev));
  const removeOption = (i: number) =>
    setOptions((prev) => (prev.length > 2 ? prev.filter((_, idx) => idx !== i) : prev));

  const resetComposer = () => {
    setQuestion("");
    setOptions(["", ""]);
    setErr(null);
    setComposing(false);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    // An option that resolves to a real ticker carries it through (for deep-links);
    // otherwise it's free text.
    const drafts: PollOptionDraft[] = options
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((raw) => {
        const match = resolveSymbol(raw);
        return match ? { label: match.symbol, ticker: match.symbol } : { label: raw, ticker: null };
      });
    const r = await createPoll(question, drafts, null);
    setBusy(false);
    if (r.ok) resetComposer();
    else setErr(r.error ?? "Couldn't create the poll.");
  };

  const validDraft = question.trim() && options.filter((o) => o.trim()).length >= 2;

  return (
    <section className="grp-panel grp-polls" aria-labelledby="grp-polls-title">
      <header className="grp-panel__head">
        <div className="grp-panel__title" id="grp-polls-title">
          <IconPoll size={17} />
          <span>Polls</span>
          {polls.length > 0 && <span className="grp-panel__count mono">{polls.length}</span>}
        </div>
        {!composing && (
          <button className="btn btn--primary btn--sm" onClick={() => setComposing(true)}>
            <IconPlus size={14} /> New poll
          </button>
        )}
      </header>

      {composing && (
        <div className="grp-poll-new">
          <input
            className="grp-poll-new__q"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask your group… e.g. Which name do we dig into next?"
            aria-label="Poll question"
            maxLength={200}
            autoFocus
          />
          <div className="grp-poll-new__opts">
            {options.map((o, i) => (
              <div className="grp-poll-new__optrow" key={i}>
                <input
                  className="grp-poll-new__opt mono"
                  value={o}
                  onChange={(e) => setOption(i, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && i === options.length - 1 && addOption()}
                  placeholder={`Option ${i + 1} — a ticker or free text`}
                  aria-label={`Option ${i + 1}`}
                  maxLength={80}
                />
                {options.length > 2 && (
                  <button
                    className="grp-iconbtn grp-iconbtn--danger"
                    onClick={() => removeOption(i)}
                    title="Remove option"
                    aria-label={`Remove option ${i + 1}`}
                  >
                    <IconTrash size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="grp-poll-new__actions">
            {options.length < MAX_OPTIONS && (
              <button className="grp-chipbtn" onClick={addOption}>
                <IconPlusCircle size={14} /> Add option
              </button>
            )}
            <span className="grp-poll-new__spacer" />
            <button className="grp-textbtn" onClick={resetComposer} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn--primary btn--sm" onClick={() => void submit()} disabled={busy || !validDraft}>
              {busy ? "Creating…" : "Launch poll"}
            </button>
          </div>
          {err && <p className="grp-form__error" role="alert">{err}</p>}
        </div>
      )}

      {ordered.length === 0 ? (
        !composing && (
          <div className="empty grp-empty">
            <IconPoll size={24} />
            <p>No polls yet. Open one to settle a debate — which stock to look at next, buy/hold/sell, anything.</p>
          </div>
        )
      ) : (
        <ul className="grp-poll-list">
          {ordered.map((poll) => (
            <PollCard key={poll.id} poll={poll} currentUserId={currentUserId} isAdmin={isAdmin} now={now} />
          ))}
        </ul>
      )}
    </section>
  );
}
