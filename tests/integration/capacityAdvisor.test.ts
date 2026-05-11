/**
 * tests/integration/capacityAdvisor.test.ts
 *
 * Integration coverage for the Capacity Advisor endpoints. Exercises the
 * non-mutating GET, the validation behaviour of POST /stage, and a few
 * staging code paths that don't actually write to .env (advisory-only is
 * skipped; unknown lever keys return per-row errors). The "applied" path
 * that mutates .env is deliberately not exercised here — that would leave
 * the test process's runtime .env in an unexpected state.
 *
 * Requires a running PostgreSQL pointed to by DATABASE_URL. The suite uses
 * `dbDescribe` so it skips cleanly when the DB is unreachable.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbReachable, dbDescribe, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

// ───────────────────────────────────────────────────────────────────────────

d("GET /api/v1/server-settings/capacity-advisor", () => {
  it("returns advisor + capacity + pgTuning payload for an admin", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/server-settings/capacity-advisor");
    expect(res.status).toBe(200);
    // Shape check — every top-level key the UI consumes.
    expect(res.body).toHaveProperty("advisor");
    expect(res.body).toHaveProperty("capacity");
    expect(res.body).toHaveProperty("pgTuning");
    // Advisor structure.
    expect(res.body.advisor).toHaveProperty("recommendations");
    expect(Array.isArray(res.body.advisor.recommendations)).toBe(true);
    expect(res.body.advisor).toHaveProperty("cadenceSamples");
    expect(res.body.advisor).toHaveProperty("recommendedQueueMode");
    expect(res.body.advisor).toHaveProperty("activeQueueMode");
    // Every documented lever key is present.
    const keys = res.body.advisor.recommendations.map((r: any) => r.key);
    expect(keys).toContain("QUEUE_MODE");
    expect(keys).toContain("DATABASE_POOL_SIZE");
    expect(keys).toContain("POLARIS_PGBOSS_POOL_SIZE");
    expect(keys).toContain("PG_MAX_CONNECTIONS");
    // Capacity snapshot is layered in.
    expect(res.body.capacity).toHaveProperty("severity");
    expect(res.body.capacity).toHaveProperty("reasons");
  });

  it("rejects unauthenticated callers with 401", async () => {
    const request = (await import("supertest")).default;
    const res = await request(app).get("/api/v1/server-settings/capacity-advisor");
    expect(res.status).toBe(401);
  });
});

// ───────────────────────────────────────────────────────────────────────────

d("POST /api/v1/server-settings/capacity-advisor/stage", () => {
  it("returns 400 when keys is missing or empty", async () => {
    const { agent, csrf } = await authedAgent(app);
    const noKeys = await agent
      .post("/api/v1/server-settings/capacity-advisor/stage")
      .set("X-CSRF-Token", csrf)
      .send({});
    expect(noKeys.status).toBe(400);

    const empty = await agent
      .post("/api/v1/server-settings/capacity-advisor/stage")
      .set("X-CSRF-Token", csrf)
      .send({ keys: [] });
    expect(empty.status).toBe(400);
  });

  it("skips advisory-only lever keys (max_connections requires PostgreSQL restart)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/server-settings/capacity-advisor/stage")
      .set("X-CSRF-Token", csrf)
      .send({ keys: ["PG_MAX_CONNECTIONS"] });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].key).toBe("PG_MAX_CONNECTIONS");
    expect(res.body.results[0].status).toBe("skipped");
    expect(res.body.results[0].reason).toMatch(/advisory-only/i);
    // No env writes → no restart required signal.
    expect(res.body.restartRequired).toBe(false);
  });

  it("returns per-key error for unknown lever names without throwing", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent
      .post("/api/v1/server-settings/capacity-advisor/stage")
      .set("X-CSRF-Token", csrf)
      .send({ keys: ["NOT_A_REAL_LEVER"] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.results[0].status).toBe("error");
    expect(res.body.results[0].reason).toMatch(/unknown/i);
  });

  it("emits a capacity_advisor.stage_failed Event when every entry errors", async () => {
    const before = await prisma.event.count({
      where: { action: "capacity_advisor.stage_failed" },
    });
    const { agent, csrf } = await authedAgent(app);
    await agent
      .post("/api/v1/server-settings/capacity-advisor/stage")
      .set("X-CSRF-Token", csrf)
      .send({ keys: ["NOT_A_REAL_LEVER"] });
    const after = await prisma.event.count({
      where: { action: "capacity_advisor.stage_failed" },
    });
    expect(after).toBeGreaterThanOrEqual(before + 1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Regression: capacityService no longer emits the legacy pgboss_* reasons.

d("capacity reasons no longer carry pgboss_* codes", () => {
  it("GET /capacity-advisor's capacity.reasons never includes pgboss_recommended/overdue/pending", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get("/api/v1/server-settings/capacity-advisor");
    expect(res.status).toBe(200);
    const codes = (res.body.capacity?.reasons ?? []).map((r: any) => r.code);
    for (const legacy of ["pgboss_recommended", "pgboss_overdue", "pgboss_pending"]) {
      expect(codes).not.toContain(legacy);
    }
  });
});
