-- Flipped true the first time the user actually logs in. Drives the sidebar
-- "new user — review role" notification for admins; Dismiss clears it
-- globally so the badge disappears for every admin at once.

ALTER TABLE "users"
  ADD COLUMN "needs_role_review" BOOLEAN NOT NULL DEFAULT false;
