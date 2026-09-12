-- Pending password change, so the first-login flow can actually fire.
--
-- The dashboard has always had a ChangePassword screen and an Onboarding
-- screen behind it, gated on a `needsPasswordChange` flag — and nothing
-- ever set it: SignIn hardcoded `login(user, false)` and the server had no
-- such concept, so both pages were unreachable and the working endpoints
-- behind them had no caller.
--
-- Set when an admin creates a user (the admin picks a temporary password
-- the user should not keep) and when the bootstrap admin is seeded from
-- env. Cleared when the user changes their password.
ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "mustChangePassword" boolean NOT NULL DEFAULT false;
