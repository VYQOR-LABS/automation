DO $migration$
BEGIN
	IF to_regclass('public.integration_accounts') IS NOT NULL THEN
		ALTER TABLE "integration_accounts" ALTER COLUMN "user_id" DROP NOT NULL;
		CREATE UNIQUE INDEX IF NOT EXISTS "integration_accounts_google_shared_uidx"
		ON "integration_accounts" ("provider")
		WHERE "user_id" IS NULL AND "provider" = 'google' AND "status" = 'active';
	END IF;
END
$migration$;
