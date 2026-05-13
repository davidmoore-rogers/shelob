-- Polaris Agent — Phase 1a data model.
--
-- One row per (asset × agent install). Independent of asset_sources —
-- installing an agent doesn't change discovery identity, it just adds a
-- new polling transport (`responseTimePolling="agent"` etc.) that the agent
-- satisfies by pushing samples back to Polaris.
--
-- Two token columns: enrollment_token_* is one-shot (10-min TTL), NULLed
-- atomically when POST /api/v1/agents/enroll succeeds; bearer_* is the
-- long-lived per-agent token issued at that moment, used for every
-- subsequent /samples / /config / /heartbeat call and the outbound WS.
-- Both stored as argon2id hashes + a short prefix for indexed lookup,
-- matching the api_tokens pattern.
--
-- The bearer is bound to a single asset via the UNIQUE constraint on
-- assetId — defense against a stolen bearer being used to write samples
-- for a different asset (the /samples handler stamps the bearer's assetId
-- server-side and ignores any client-supplied value).
--
-- serverCertFingerprint is sha256:<hex> of the leaf cert at install time;
-- pinned in the host config so the agent does NOT trust system roots.

CREATE TABLE "managed_agents" (
  "id"                      TEXT PRIMARY KEY,
  "assetId"                 TEXT NOT NULL UNIQUE,
  "osPlatform"              TEXT NOT NULL,
  "arch"                    TEXT NOT NULL,
  "agentVersion"            TEXT,
  "installedBy"             TEXT NOT NULL,
  "installedAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "installStatus"           TEXT NOT NULL DEFAULT 'pending',
  "installError"            TEXT,

  "enrollmentTokenHash"     TEXT,
  "enrollmentTokenPrefix"   TEXT,
  "enrollmentExpiresAt"     TIMESTAMP(3),

  "bearerHash"              TEXT,
  "bearerPrefix"            TEXT,
  "bearerIssuedAt"          TIMESTAMP(3),
  "bearerRevokedAt"         TIMESTAMP(3),

  "lastSeenAt"              TIMESTAMP(3),
  "lastSeenIp"              TEXT,
  "wsConnectedAt"           TIMESTAMP(3),
  "wsDisconnectedAt"        TIMESTAMP(3),

  "serverCertFingerprint"   TEXT NOT NULL,

  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,

  CONSTRAINT "managed_agents_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "managed_agents_installStatus_idx"         ON "managed_agents"("installStatus");
CREATE INDEX "managed_agents_bearerPrefix_idx"          ON "managed_agents"("bearerPrefix");
CREATE INDEX "managed_agents_enrollmentTokenPrefix_idx" ON "managed_agents"("enrollmentTokenPrefix");
