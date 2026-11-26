import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useAppStore } from "@/store/useAppStore";
import { useAuthStore } from "@/store/useAuthStore";
import { useGroupsStore } from "@/store/useGroupsStore";
import { isAdminEmail } from "@/lib/admin";
import { InvestingDisclaimer } from "@/components/common/InvestingDisclaimer";
import { AccountChip } from "@/components/layout/AccountChip";
import { APP_NAME } from "@/lib/app";
import { SYSTEM_NAV } from "@/config/navigationLabels";
import { IconGroups } from "@/components/groups/icons";
import { IconHeatmap } from "@/components/heatmap/icons";
import {
  IconForYou,
  IconFriends,
  IconLayers,
  IconPortfolios,
  IconResearch,
  IconBeacon,
  IconCore,
  IconForge,
  IconScale,
  IconShield,
  IconTarget,
  IconToday,
  IconUser,
  IconWatchlist,
  IconWeekly,
  IconTerminal,
} from "@/components/icons";

interface NavItem {
  to: string;
  label: string;
  icon: typeof IconToday;
  badge?: number;
  /**
   * True when `badge` is a "needs a response" notification (friend request, group
   * invite) rather than an informational count (how many portfolios/watchlist
   * items you have). Only attention badges bubble up to the mobile "More" tab, so
   * the More dot means "something needs you," not "you own 1 portfolio".
   */
  attention?: boolean;
  /** Override NavLink's path-only active state (e.g. distinguish ?view=lab). */
  forceActive?: boolean;
}

export function Sidebar() {
  const { pathname, search } = useLocation();
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const watchlistCount = useAppStore((s) => s.watchlist.length);
  const portfolioCount = useAppStore((s) => s.portfolios.filter((p) => p.owner === "me").length);
  const isAdmin = useAuthStore((s) => isAdminEmail(s.email));

  // App-wide unread badge for Groups: the number of the viewer's groups with
  // unread activity. Driven by the app-level groups sync (initGroupsSync), so the
  // dot is live on every route - not only while the /groups page is open. We
  // depend on the slices unreadFor() reads so the count recomputes on a change.
  const groupsUnread = useGroupsStore((s) => {
    let n = 0;
    for (const g of s.groups) if (s.unreadFor(g.id) > 0) n += 1;
    return n;
  });
  // "Needs a response" social counts: incoming friend requests + pending group
  // invites. Both are loaded app-wide on sign-in (initFriendsSync / initGroupsSync)
  // and stay live via realtime, so these badges are correct on EVERY route and the
  // instant the app reopens - not only on the Friends/Groups page. This is what
  // surfaces a request that would otherwise sit unseen under the mobile "More" tab.
  const friendRequests = useAuthStore((s) => s.incoming.length);
  const groupInvites = useGroupsStore((s) => s.pendingInvites.length);

  const feeds: NavItem[] = [
    { to: "/today", label: "Today", icon: IconToday },
    { to: "/weekly", label: "Weekly", icon: IconWeekly },
    { to: "/for-you", label: "For You", icon: IconForYou },
  ];
  const social: NavItem[] = [
    { to: "/friends", label: "Friends", icon: IconFriends, badge: friendRequests, attention: true },
    {
      to: "/groups",
      label: "Groups",
      icon: IconGroups,
      badge: groupsUnread + groupInvites,
      attention: true,
    },
  ];
  const library: NavItem[] = [
    { to: "/portfolios", label: "Portfolios", icon: IconPortfolios, badge: portfolioCount },
    { to: "/watchlist", label: "Watchlist", icon: IconWatchlist, badge: watchlistCount },
    { to: "/heatmap", label: "Market Map", icon: IconHeatmap },
  ];
  const system: NavItem[] = [
    { to: SYSTEM_NAV.forge.path, label: SYSTEM_NAV.forge.label, icon: IconForge },
    { to: SYSTEM_NAV.beacon.path, label: SYSTEM_NAV.beacon.label, icon: IconBeacon },
    { to: SYSTEM_NAV.terminal.path, label: SYSTEM_NAV.terminal.label, icon: IconTerminal },
    { to: "/research", label: "Research", icon: IconResearch },
  ];
  // The performance ledger is an operator surface; in local/dev (no operator
  // Performance and Model Lab share the /performance route, split by ?view=lab -
  // resolve which one owns the active highlight so they never both light up.
  const onPerf = pathname === "/performance";
  const labView = onPerf && new URLSearchParams(search).get("view") === "lab";
  // "Engine" groups the product's intelligence surfaces into one place: how the algorithm works
  // (Algorithm), how it has actually performed (Track Record), and the champion/challenger
  // comparison (Model Lab). These are READ-ONLY explainers, so they're visible to EVERYONE
  // (incl. signed-out) - only the Operator console (which can MUTATE the live engine) is gated
  // to admins.
  const engine: NavItem[] = [
    { to: SYSTEM_NAV.core.path, label: SYSTEM_NAV.core.label, icon: IconCore },
    { to: "/performance", label: "Track Record", icon: IconTarget, forceActive: onPerf && !labView },
    { to: "/performance?view=lab", label: "Model Lab", icon: IconScale, forceActive: labView },
  ];
  const account: NavItem[] = [
    { to: "/desk", label: "Your Desk", icon: IconUser },
    ...(isAdmin ? [{ to: "/admin", label: "Operator", icon: IconShield }] : []),
  ];
  // Bottom tab bar (phones): the 5 tabs that belong up front + a More overflow.
  const mobilePrimary: NavItem[] = [
    feeds[0], // Today
    library[2], // Market Map (heatmap)
    social[1], // Groups
    system[1], // Ticker Scope (beacon)
    system[3], // Research
  ];
  // Everything NOT in the primary bar lives in More.
  const mobileMore: NavItem[] = [
    feeds[1], // Weekly
    feeds[2], // For You
    social[0], // Friends
    library[0], // Portfolios
    library[1], // Watchlist
    system[0], // Blueprint
    system[2], // Terminal
    ...engine, // Algorithm, Track Record, Model Lab
    ...account, // Your Desk, Operator
  ];
  const mobileMoreActive = mobileMore.some((item) => pathname.startsWith(item.to));
  // Bubble ONLY "needs a response" notifications (friend requests, group invites)
  // from items buried under "More" onto the More tab - never informational counts
  // like portfolio/watchlist totals. So a friend request (Friends lives under More)
  // is never invisible, but the More dot doesn't cry wolf for "you own 1 portfolio".
  const mobileMoreBadge = mobileMore.reduce(
    (sum, item) => sum + (item.attention ? (item.badge ?? 0) : 0),
    0,
  );

  useEffect(() => {
    setMobileMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileMoreOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMoreOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileMoreOpen]);

  const renderItems = (items: NavItem[]) =>
    items.map(({ to, label, icon: Icon, badge, forceActive }) => (
      <NavLink
        key={to}
        to={to}
        className={({ isActive }) => `nav__item ${(forceActive ?? isActive) ? "active" : ""}`}
      >
        <Icon className="nav__icon" size={18} />
        <span>{label}</span>
        {badge != null && badge > 0 && <span className="nav__badge">{badge}</span>}
      </NavLink>
    ));

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand__mark" />
        <div>
          <div className="brand__name">{APP_NAME}</div>
          <div className="brand__sub">Signal discovery</div>
        </div>
      </div>

      <nav className="nav nav--desktop">
        <div className="nav__section">Feeds</div>
        {renderItems(feeds)}
        <div className="nav__section">Social</div>
        {renderItems(social)}
        <div className="nav__section">Library</div>
        {renderItems(library)}
        <div className="nav__section">System</div>
        {renderItems(system)}
        <div className="nav__section">Engine</div>
        {renderItems(engine)}
        <div className="nav__section">Account</div>
        {renderItems(account)}
      </nav>

      <div className="sidebar__footer">
        <InvestingDisclaimer compact />
        <AccountChip />
      </div>

      {mobileMoreOpen && (
        <>
          <button
            type="button"
            className="mobile-nav__backdrop"
            aria-label="Close more navigation"
            onClick={() => setMobileMoreOpen(false)}
          />
          <nav
            id="mobile-more-navigation"
            className="mobile-nav__more-panel"
            aria-label="More navigation"
          >
            <div className="mobile-nav__more-head">
              <span>More</span>
              <button
                type="button"
                className="mobile-nav__more-close"
                onClick={() => setMobileMoreOpen(false)}
              >
                Close
              </button>
            </div>
            <div className="mobile-nav__more-grid">
              {mobileMore.map(({ to, label, icon: Icon, badge, forceActive }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `mobile-nav__more-item ${(forceActive ?? isActive) ? "active" : ""}`
                  }
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  {badge != null && badge > 0 && (
                    <span className="mobile-nav__more-badge">{badge}</span>
                  )}
                </NavLink>
              ))}
            </div>
          </nav>
        </>
      )}

      <nav className="mobile-nav" aria-label="Primary navigation">
        {mobilePrimary.map(({ to, label, icon: Icon, badge }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `mobile-nav__item ${isActive ? "active" : ""}`}
          >
            <Icon className="mobile-nav__icon" size={19} />
            <span>{label}</span>
            {badge != null && badge > 0 && <span className="mobile-nav__badge">{badge}</span>}
          </NavLink>
        ))}
        <button
          type="button"
          className={`mobile-nav__item ${mobileMoreActive || mobileMoreOpen ? "active" : ""}`}
          aria-expanded={mobileMoreOpen}
          aria-controls="mobile-more-navigation"
          onClick={() => setMobileMoreOpen((open) => !open)}
        >
          <IconLayers className="mobile-nav__icon" size={19} />
          <span>More</span>
          {mobileMoreBadge > 0 && <span className="mobile-nav__badge">{mobileMoreBadge}</span>}
        </button>
      </nav>
    </aside>
  );
}
