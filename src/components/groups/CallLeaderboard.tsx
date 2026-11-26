import { useGroupsStore } from "@/store/useGroupsStore";
import { buildLeaderboard, type LeaderboardRow } from "@/data/groups/leaderboard";
import { relativeTime } from "@/lib/format";
import { GroupAvatar, ReturnValue } from "./shared";
import { IconTrophy } from "./icons";

const MEDAL = ["①", "②", "③"];

/** Short status word for a call that isn't ranked yet - mirrors CallLedger's StatusPill copy. */
function pendingLabel(status: LeaderboardRow["perf"]["status"], direction: string): string {
  if (status === "unpriced") return "no quote";
  if (status === "pending") return "pending";
  return direction === "watch" ? "watch — not ranked" : "pending";
}

function Row({ row, now }: { row: LeaderboardRow; now: number }) {
  const { perf, rank } = row;
  const call = perf.call;
  const name = call.author.displayName || call.author.handle || "Member";
  const ranked = rank != null;
  return (
    <li className={`grp-lb-row ${ranked && rank < 3 ? `grp-lb-row--top grp-lb-row--${rank + 1}` : ""}`}>
      <span className="grp-lb-rank mono" aria-label={ranked ? `Rank ${rank + 1}` : "Not yet ranked"}>
        {ranked ? (rank < 3 ? MEDAL[rank] : rank + 1) : "—"}
      </span>
      <GroupAvatar profile={call.author} size={34} />
      <div className="grp-lb-id">
        <span className="grp-lb-name">{name}</span>
        <span className="grp-lb-sub text-faint">
          <span className="ticker mono">{call.ticker}</span> · {relativeTime(call.calledAt, now)}
        </span>
      </div>
      <div className="grp-lb-perf">
        {ranked ? (
          <ReturnValue ratio={perf.returnPct} className="grp-lb-avg" />
        ) : (
          <span className="grp-lb-avg grp-lb-avg--pending">{pendingLabel(perf.status, call.direction)}</span>
        )}
      </div>
    </li>
  );
}

export function CallLeaderboard({
  leaderboardEnabled,
  isAdmin,
}: {
  leaderboardEnabled: boolean;
  isAdmin: boolean;
}) {
  const calls = useGroupsStore((s) => s.calls);
  const prices = useGroupsStore((s) => s.prices);
  const setLeaderboard = useGroupsStore((s) => s.setLeaderboard);

  const now = Date.now();
  const board = buildLeaderboard(calls, prices, now);
  const anyScored = board.some((r) => r.rank != null);

  if (!leaderboardEnabled) {
    return (
      <section className="grp-panel" aria-labelledby="grp-lb-title">
        <header className="grp-panel__head">
          <div className="grp-panel__title" id="grp-lb-title">
            <IconTrophy size={17} />
            <span>Call leaderboard</span>
          </div>
        </header>
        <div className="empty grp-empty">
          <IconTrophy size={24} />
          <p>The leaderboard is turned off for this group.</p>
          {isAdmin && (
            <button className="btn btn--ghost btn--sm" onClick={() => void setLeaderboard(true)}>
              Turn it on
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="grp-panel grp-panel--leaderboard" aria-labelledby="grp-lb-title">
      <header className="grp-panel__head">
        <div className="grp-panel__title" id="grp-lb-title">
          <IconTrophy size={17} />
          <span>Call leaderboard</span>
        </div>
      </header>

      <p className="grp-lb-explain text-faint">
        Every <strong>buy</strong> call is ranked on its own, best return first. Watches and calls under an hour old are tracked but don't count yet.
      </p>

      {board.length === 0 ? (
        <div className="empty grp-empty">
          <IconTrophy size={24} />
          <p>No calls yet — the leaderboard fills in as members log their picks.</p>
        </div>
      ) : (
        <>
          {!anyScored && (
            <div className="grp-lb-cold">
              Calls are in, but none have matured yet. Returns start counting about an hour after each call.
            </div>
          )}
          <ol className="grp-lb-list">
            {board.map((row) => (
              <Row key={row.perf.call.id} row={row} now={now} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
