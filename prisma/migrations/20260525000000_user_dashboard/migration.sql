-- Per-user dashboard layout. One row per user; absent row = empty dashboard.
-- Layout JSON shape is { version: 1, widgets: WidgetInstance[] } validated by
-- Zod at the route layer (see src/api/routes/userDashboard.ts). Persists
-- server-side so layouts follow operators across browsers and devices.

CREATE TABLE "user_dashboards" (
  "user_id"    TEXT      NOT NULL,
  "layout"     JSONB     NOT NULL,
  "updated_at" TIMESTAMP NOT NULL,

  CONSTRAINT "user_dashboards_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "user_dashboards_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
