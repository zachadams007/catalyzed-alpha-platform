import { getTodayUsageByVendor } from "@/lib/apiUsage";

function formatUsageLine({ vendor, calls, err }) {
  return `${vendor} ${calls}${err > 0 ? ` (${err} err)` : ""}`;
}

export async function reportScanUsage(log = console.log) {
  try {
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      log("  scan API usage report skipped: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set.");
      return;
    }

    const usage = getTodayUsageByVendor().filter(({ ok, err }) => ok + err > 0);
    if (usage.length === 0) {
      log("  scan API usage report skipped: no vendor calls recorded today.");
      return;
    }

    const endpoint = `${url.replace(/\/+$/, "")}/rest/v1/rpc/bump_api_usage_batch`;
    const reported = [];

    await Promise.all(
      usage.map(async ({ vendor, ok, err }) => {
        const calls = ok + err;
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              p_vendor: vendor,
              p_key_label: "scan",
              p_calls: calls,
              p_failures: err,
            }),
          });
          if (!res.ok) {
            const detail = await res.text().catch(() => "");
            throw new Error(`${res.status} ${detail.slice(0, 200)}`.trim());
          }
          reported.push({ vendor, calls, err });
        } catch (errObj) {
          log(
            `  scan API usage report failed for ${vendor} (non-fatal): ${
              errObj instanceof Error ? errObj.message : errObj
            }`,
          );
        }
      }),
    );

    if (reported.length === 0) {
      log("  scan API usage report completed with no successful vendor writes.");
      return;
    }

    reported.sort((a, b) => a.vendor.localeCompare(b.vendor));
    log(
      `Reported scan API usage: ${reported
        .map(formatUsageLine)
        .join(", ")} -> api_usage_daily (key_label=scan).`,
    );
  } catch (err) {
    log(
      `  scan API usage report failed before posting (non-fatal): ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}
