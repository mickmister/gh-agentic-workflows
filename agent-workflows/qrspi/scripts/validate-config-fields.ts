/** QRSPI's structural companion to the legacy partial shell fixture.
 * Parsing and disposable-file I/O belong to the calling adapter. No mutation,
 * backfill, model selection, phase transition or approval occurs here.
 */
export function validateConfigField(config: unknown, field: string): string | undefined {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(config)) return "config.md must contain a YAML frontmatter mapping";
  if (["verifier_enabled", "scope_tagger_enabled"].includes(field)) {
    return typeof config[field] === "boolean" ? undefined : `${field} must be explicitly true or false`;
  }
  if (field !== "model_routing") return `Unsupported companion field: ${field}`;
  const tiers = ["extra-low", "low", "medium", "high", "extra-high"];
  const routing = config.model_routing;
  if (!object(routing)) return "Missing or malformed model_routing: supply the five-tier mapping";
  if (Object.keys(routing).length !== tiers.length || Object.keys(routing).some(key => !tiers.includes(key))) {
    return "model_routing must contain exactly extra-low, low, medium, high, extra-high";
  }
  for (const tier of tiers) {
    const row = routing[tier];
    if (row === "none") continue;
    if (!object(row) || Object.keys(row).length !== 2 ||
        typeof row.vendor !== "string" || !row.vendor.trim() ||
        typeof row.model !== "string" || !row.model.trim()) {
      return `Malformed model_routing tier ${tier}: expected none or { vendor: <vendor>, model: <model> }`;
    }
  }
  if (typeof config.default_tier !== "string" || !tiers.includes(config.default_tier)) {
    return "default_tier must explicitly name one of the five routing tiers";
  }
}
