-- Service settings (Agent): the Operations and Event types a Custom Agent's Service skill switches on in the Project configuration every new Project of the Agent starts with.
ALTER TABLE "agent_profile_skills" ADD COLUMN "service_settings" jsonb;
