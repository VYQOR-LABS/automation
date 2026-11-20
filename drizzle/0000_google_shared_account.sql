ALTER TABLE "integration_accounts" ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_accounts_google_shared_uidx"
ON "integration_accounts" ("provider")
WHERE "user_id" IS NULL AND "provider" = 'google' AND "status" = 'active';
