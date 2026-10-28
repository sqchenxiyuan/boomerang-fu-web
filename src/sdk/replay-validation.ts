import generated from './replay-schema.json';
type Schema = {
  type?: string;
  enum?: unknown[];
  any?: Schema[];
  array?: Schema;
  fields?: Record<string, Schema>;
  optional?: string[];
  ref?: string;
  record?: Schema;
  prefix?: string;
};
const definitions = generated.definitions as Record<string, Schema>;
function valid(value: unknown, schema: Schema): boolean {
  if (schema.ref) return valid(value, definitions[schema.ref]);
  if (schema.type) return typeof value === schema.type;
  if (schema.enum) return schema.enum.includes(value);
  if (schema.any) return schema.any.some((candidate) => valid(value, candidate));
  if (schema.prefix) return typeof value === 'string' && value.startsWith(schema.prefix);
  if (schema.array)
    return Array.isArray(value) && value.every((item) => valid(item, schema.array!));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (schema.record) return Object.values(value).every((item) => valid(item, schema.record!));
  return Object.entries(schema.fields!).every(([key, field]) => {
    const item = (value as Record<string, unknown>)[key];
    return (item === undefined && schema.optional!.includes(key)) || valid(item, field);
  });
}
export function validateReplayState(value: unknown): void {
  if (!valid(value, definitions.GameState))
    throw new TypeError('Invalid checkpoint world structure');
}
