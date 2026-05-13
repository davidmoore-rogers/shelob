-- Polaris Agent Phase 4a: store the install credential on ManagedAgent so
-- the default DELETE path can reuse it for the remote uninstall without
-- making the operator re-pick.
--
-- SetNull on Credential delete so removing a Credential doesn't block
-- removing a stuck ManagedAgent — operator falls back to DELETE
-- /assets/:id/agent?force=true in that case.

ALTER TABLE "managed_agents"
  ADD COLUMN "installCredentialId" TEXT;

ALTER TABLE "managed_agents"
  ADD CONSTRAINT "managed_agents_installCredentialId_fkey"
  FOREIGN KEY ("installCredentialId") REFERENCES "credentials"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "managed_agents_installCredentialId_idx"
  ON "managed_agents"("installCredentialId");
