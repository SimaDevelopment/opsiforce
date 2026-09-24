CREATE TABLE "tenant_disabled_agents" (
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"disabled_at" timestamp DEFAULT now() NOT NULL,
	"disabled_by" text,
	CONSTRAINT "tenant_disabled_agents_tenant_id_agent_id_pk" PRIMARY KEY("tenant_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_disabled_skills" (
	"tenant_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"disabled_at" timestamp DEFAULT now() NOT NULL,
	"disabled_by" text,
	CONSTRAINT "tenant_disabled_skills_tenant_id_skill_id_pk" PRIMARY KEY("tenant_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_disabled_agents" ADD CONSTRAINT "tenant_disabled_agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_disabled_agents" ADD CONSTRAINT "tenant_disabled_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_disabled_agents" ADD CONSTRAINT "tenant_disabled_agents_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_disabled_skills" ADD CONSTRAINT "tenant_disabled_skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_disabled_skills" ADD CONSTRAINT "tenant_disabled_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_disabled_skills" ADD CONSTRAINT "tenant_disabled_skills_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "tenant_disabled_agents" ("tenant_id", "agent_id")
SELECT "tenant_id", "id" FROM "agents" WHERE "disabled" AND "tenant_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "tenant_disabled_skills" ("tenant_id", "skill_id")
SELECT "tenant_id", "id" FROM "skills" WHERE "disabled" AND "tenant_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "disabled";--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "disabled";
