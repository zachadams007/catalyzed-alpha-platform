import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@tauri-apps/api/core";

type ExternalLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "target" | "rel"> & {
  href: string;
  children: ReactNode;
};

/** Opens http(s) links in the system browser (required inside the Tauri webview). */
export function ExternalLink({ href, onClick, children, ...rest }: ExternalLinkProps) {
  const handleClick = async (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;

    if (!href.startsWith("http://") && !href.startsWith("https://")) return;

    if (isTauri()) {
      e.preventDefault();
      await openUrl(href);
    }
  };

  return (
    <a href={href} target="_blank" rel="noreferrer noopener" onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
