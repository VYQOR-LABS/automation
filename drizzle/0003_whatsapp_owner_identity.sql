ALTER TABLE "public"."integration_accounts"
	ADD COLUMN IF NOT EXISTS "business_account_id" varchar(255);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_accounts_whatsapp_owner_uidx"
	ON "public"."integration_accounts" ("provider")
	WHERE "provider" = 'whatsapp' AND "status" = 'active';
