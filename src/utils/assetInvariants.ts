/**
 * src/utils/assetInvariants.ts — Shared write-time invariants for Asset records.
 */

type DateLike = Date | string | null | undefined;

/**
 * An asset's acquiredAt must never be after its lastSeen — you can't be
 * seen before you were acquired. When a write would violate that (either
 * from a manual edit or from a discovery update clobbering one field
 * while leaving the other), clamp acquiredAt down to match lastSeen.
 *
 * Mutates the passed `data` object. `existing` supplies the pre-update
 * values for fields the write isn't touching; omit for creates.
 */
export function clampAcquiredToLastSeen(
  data: Record<string, unknown>,
  existing?: { acquiredAt?: DateLike; lastSeen?: DateLike } | null,
): void {
  const acqRaw = "acquiredAt" in data ? (data.acquiredAt as DateLike) : existing?.acquiredAt ?? null;
  const seenRaw = "lastSeen" in data ? (data.lastSeen as DateLike) : existing?.lastSeen ?? null;
  if (!acqRaw || !seenRaw) return;
  const acq = acqRaw instanceof Date ? acqRaw : new Date(acqRaw);
  const seen = seenRaw instanceof Date ? seenRaw : new Date(seenRaw);
  if (Number.isNaN(acq.getTime()) || Number.isNaN(seen.getTime())) return;
  if (seen < acq) data.acquiredAt = seen;
}
