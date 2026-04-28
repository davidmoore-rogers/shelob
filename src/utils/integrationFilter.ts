/**
 * Decide whether an asset would still be in scope for the integration that
 * originally discovered it. Used by the manual /assets/:id/probe-now refresh
 * to short-circuit when the operator has since narrowed the integration's
 * deviceInclude / deviceExclude — a refresh shouldn't pull data from a
 * device the next discovery sweep would skip.
 *
 * Per-integration matching:
 *   - fortimanager / fortigate: deviceInclude/deviceExclude vs hostname
 *   - entraid:                   deviceInclude/deviceExclude vs hostname (Entra displayName lands in Asset.hostname)
 *   - activedirectory:           ouInclude/ouExclude vs learnedLocation (the OU path written by the AD sync)
 *
 * Returns { included: true } for any other integration type (we don't have
 * authoritative match data for it) so we never block a refresh on a hunch.
 */

interface IntegrationLite {
  type: string;
  config: unknown;
}

interface AssetLite {
  hostname: string | null;
  learnedLocation: string | null;
}

function matchesWildcard(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*") && p.endsWith("*") && p.length > 2) return v.includes(p.slice(1, -1));
  if (p.startsWith("*")) return v.endsWith(p.slice(1));
  if (p.endsWith("*")) return v.startsWith(p.slice(0, -1));
  return v === p;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

export interface FilterResult {
  included: boolean;
  reason?: string;
}

export function assetMatchesIntegrationFilter(
  asset: AssetLite,
  integration: IntegrationLite,
): FilterResult {
  const cfg = (integration.config && typeof integration.config === "object")
    ? integration.config as Record<string, unknown>
    : {};
  const type = integration.type;

  // FMG / FortiGate / Entra: filter on hostname.
  if (type === "fortimanager" || type === "fortigate" || type === "entraid") {
    const include = asStringArray(cfg.deviceInclude);
    const exclude = asStringArray(cfg.deviceExclude);
    const candidate = asset.hostname || "";
    if (!candidate) return { included: true }; // can't evaluate without a hostname

    if (include.length > 0) {
      const ok = include.some((p) => matchesWildcard(p, candidate));
      if (!ok) return { included: false, reason: `Excluded by ${type} integration deviceInclude (${candidate} matches no pattern)` };
    } else if (exclude.length > 0) {
      const blocked = exclude.find((p) => matchesWildcard(p, candidate));
      if (blocked) return { included: false, reason: `Excluded by ${type} integration deviceExclude pattern "${blocked}"` };
    }
    return { included: true };
  }

  // Active Directory: filter on the OU path. learnedLocation carries the
  // OU path the AD sync wrote (computed from distinguishedName); the AD
  // discovery filter matches against the *full* DN, so we do the same here
  // by reconstructing the closest approximation from CN + learnedLocation.
  if (type === "activedirectory") {
    const include = asStringArray(cfg.ouInclude);
    const exclude = asStringArray(cfg.ouExclude);
    const ouPath = asset.learnedLocation || "";
    if (!ouPath) return { included: true };
    const candidates = [ouPath, asset.hostname ? `CN=${asset.hostname},${ouPath}` : ""].filter(Boolean);

    if (include.length > 0) {
      const ok = include.some((p) => candidates.some((c) => matchesWildcard(p, c)));
      if (!ok) return { included: false, reason: `Excluded by activedirectory integration ouInclude (no pattern matches OU "${ouPath}")` };
    } else if (exclude.length > 0) {
      const blocked = exclude.find((p) => candidates.some((c) => matchesWildcard(p, c)));
      if (blocked) return { included: false, reason: `Excluded by activedirectory integration ouExclude pattern "${blocked}"` };
    }
    return { included: true };
  }

  return { included: true };
}
