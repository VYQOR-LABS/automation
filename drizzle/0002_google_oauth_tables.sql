DO $migration$
BEGIN
	CREATE TYPE "public"."user_status" AS ENUM('active', 'inactive', 'suspended');
EXCEPTION
	WHEN duplicate_object THEN NULL;
END
$migration$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"whatsapp_phone" varchar(32),
	"email" varchar(255),
	"full_name" varchar(255),
	"display_name" varchar(255),
	"status" "public"."user_status" DEFAULT 'active' NOT NULL,
	"locale" varchar(16) DEFAULT 'en',
	"timezone" varchar(64) DEFAULT 'UTC',
	"consent_version" numeric(8, 0) DEFAULT '1',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_active_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."integration_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid REFERENCES "public"."users"("id"),
	"provider" varchar(64) NOT NULL,
	"provider_account_id" varchar(255),
	"account_email" varchar(255),
	"authorization_scope" text,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_account_id" uuid NOT NULL REFERENCES "public"."integration_accounts"("id"),
	"access_token_encrypted" text NOT NULL,
	"refresh_token_encrypted" text,
	"token_type" varchar(32) DEFAULT 'Bearer',
	"expires_at" timestamp with time zone,
	"refresh_expires_at" timestamp with time zone,
	"scopes" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "public"."integration_accounts"
	ALTER COLUMN "user_id" DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_accounts_google_shared_uidx"
	ON "public"."integration_accounts" ("provider")
	WHERE "user_id" IS NULL AND "provider" = 'google' AND "status" = 'active';
