/**
 * A JSON Schema cut down to what Claude's strict tools and structured outputs accept. Claude
 * rejects string length, numeric bound and most array-size constraints, string formats outside
 * its list, and objects that allow other properties. Dropping a constraint only loosens what the
 * model may send: each tool's own schema still validates its input on the client, and Guardian
 * decodes its decision the same way.
 */

type Json = Readonly<Record<string, unknown>>;

const unsupported = new Set([
  "$schema",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
]);
const formats = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const keep = (key: string, value: unknown) =>
  !unsupported.has(key) &&
  // Claude accepts only 0 and 1 as an array's minimum size.
  !(key === "minItems" && typeof value === "number" && value > 1) &&
  !(key === "format" && !formats.has(String(value)));

const convert = (schema: Json, path: string): Record<string, unknown> => {
  const named = (value: unknown) =>
    Object.fromEntries(
      Object.entries(value as Json).map(([name, inner]) => [
        name,
        convert(inner as Json, `${path}.${name}`),
      ]),
    );
  const listed = (value: unknown) =>
    (value as Json[]).map((inner, index) => convert(inner, `${path}[${index}]`));
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!keep(key, value)) continue;
    if (key === "properties" || key === "$defs" || key === "definitions")
      converted[key] = named(value);
    else if (key === "items" && isRecord(value)) converted[key] = convert(value, `${path}[]`);
    else if (key === "anyOf" || key === "allOf") converted[key] = listed(value);
    // Claude has no oneOf; anyOf admits the same values when the branches are disjoint.
    else if (key === "oneOf") converted["anyOf"] = listed(value);
    else converted[key] = value;
  }
  if (converted["type"] === "object" || "properties" in converted) {
    const additional = converted["additionalProperties"];
    if (additional !== undefined && additional !== false)
      throw new Error(`Claude schema: the open record at ${path} cannot be strict`);
    converted["additionalProperties"] = false;
  }
  return converted;
};

export const claudeSchema = (schema: object): Record<string, unknown> =>
  convert(schema as Json, "$");
