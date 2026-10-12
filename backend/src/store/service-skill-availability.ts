export abstract class ServiceSkillAvailability {
  abstract availableServiceIds(tenantId: string): Promise<ReadonlySet<string>>;
}
