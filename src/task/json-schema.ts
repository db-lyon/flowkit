/**
 * Compact, dependency-free JSON Schema validator.
 *
 * Flowkit keeps its runtime dependencies to two (js-yaml, zod), so rather than
 * pull in a full validator we implement the subset that LLM structured-output
 * schemas actually use. The goal is not spec completeness — it is a precise,
 * human-readable verdict that drives the structured-output repair loop in
 * llm-runner (the error strings are fed back to the model).
 *
 * Supported keywords:
 *   type (single or array), enum, const,
 *   object: properties, required, additionalProperties (bool or schema),
 *   array:  items, minItems, maxItems,
 *   string: minLength, maxLength, pattern,
 *   number: minimum, maximum, exclusiveMinimum, exclusiveMaximum,
 *   composition: anyOf, oneOf, allOf, not,
 *   nullable (OpenAPI-style — treated as "type may also be null").
 *
 * Anything unrecognized is ignored (treated as "no constraint"), so an
 * over-rich schema validates leniently rather than throwing.
 */

export interface ValidationError {
  /** JSON-path-ish pointer to the offending value, e.g. `/items/0/name`. */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

type Schema = Record<string, unknown>;

const TYPE_OF = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
};

/** Does `value` satisfy the JSON Schema `type` token? Handles integer + null. */
function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true; // unknown type token — don't constrain
  }
}

function validateNode(value: unknown, schema: Schema, path: string, errors: ValidationError[]): void {
  // Composition keywords are evaluated independently of type.
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf as Schema[]) validateNode(value, sub, path, errors);
  }

  if (Array.isArray(schema.anyOf)) {
    const ok = (schema.anyOf as Schema[]).some((sub) => isolatedValid(value, sub, path));
    if (!ok) errors.push({ path, message: 'does not match any schema in anyOf' });
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as Schema[]).filter((sub) => isolatedValid(value, sub, path)).length;
    if (matches !== 1) {
      errors.push({ path, message: `must match exactly one schema in oneOf (matched ${matches})` });
    }
  }

  if (schema.not && typeof schema.not === 'object') {
    if (isolatedValid(value, schema.not as Schema, path)) {
      errors.push({ path, message: 'must not match the "not" schema' });
    }
  }

  // const / enum
  if ('const' in schema && !deepEqual(value, schema.const)) {
    errors.push({ path, message: `must equal ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push({ path, message: `must be one of ${JSON.stringify(schema.enum)}` });
  }

  // type (with OpenAPI-style nullable support)
  const types = normalizeTypes(schema);
  if (types && !(schema.nullable === true && value === null)) {
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({
        path,
        message: `expected type ${types.join(' | ')} but got ${TYPE_OF(value)}`,
      });
      return; // further keyword checks assume the type matched
    }
  }

  if (matchesType(value, 'object') && value !== null) {
    validateObject(value as Record<string, unknown>, schema, path, errors);
  } else if (Array.isArray(value)) {
    validateArray(value, schema, path, errors);
  } else if (typeof value === 'string') {
    validateString(value, schema, path, errors);
  } else if (typeof value === 'number') {
    validateNumber(value, schema, path, errors);
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: Schema,
  path: string,
  errors: ValidationError[],
): void {
  const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};

  if (Array.isArray(schema.required)) {
    for (const key of schema.required as string[]) {
      if (!(key in value)) errors.push({ path: join(path, key), message: 'is required' });
    }
  }

  for (const [key, sub] of Object.entries(properties)) {
    if (key in value) validateNode(value[key], sub, join(path, key), errors);
  }

  const additional = schema.additionalProperties;
  if (additional === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        errors.push({ path: join(path, key), message: 'is not an allowed property' });
      }
    }
  } else if (additional && typeof additional === 'object') {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) validateNode(value[key], additional as Schema, join(path, key), errors);
    }
  }
}

function validateArray(value: unknown[], schema: Schema, path: string, errors: ValidationError[]): void {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
    errors.push({ path, message: `must have at least ${schema.minItems} items` });
  }
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
    errors.push({ path, message: `must have at most ${schema.maxItems} items` });
  }
  if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    value.forEach((item, i) => validateNode(item, schema.items as Schema, join(path, String(i)), errors));
  }
}

function validateString(value: string, schema: Schema, path: string, errors: ValidationError[]): void {
  if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
    errors.push({ path, message: `must be at least ${schema.minLength} characters` });
  }
  if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
    errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
  }
  if (typeof schema.pattern === 'string') {
    let re: RegExp | null = null;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      re = null; // invalid pattern in schema — skip rather than throw
    }
    if (re && !re.test(value)) errors.push({ path, message: `must match pattern ${schema.pattern}` });
  }
}

function validateNumber(value: number, schema: Schema, path: string, errors: ValidationError[]): void {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    errors.push({ path, message: `must be >= ${schema.minimum}` });
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    errors.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
    errors.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
  }
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
    errors.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
  }
}

/** Validate against a sub-schema in isolation; used by anyOf/oneOf/not. */
function isolatedValid(value: unknown, schema: Schema, path: string): boolean {
  const sub: ValidationError[] = [];
  validateNode(value, schema, path, sub);
  return sub.length === 0;
}

function normalizeTypes(schema: Schema): string[] | null {
  const t = schema.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t) && t.every((x) => typeof x === 'string')) return t as string[];
  return null;
}

function join(path: string, key: string): string {
  return `${path}/${key}`;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** Validate a value against a JSON Schema. Always returns; never throws. */
export function validateJson(value: unknown, schema: Schema): ValidationResult {
  const errors: ValidationError[] = [];
  try {
    validateNode(value, schema, '', errors);
  } catch (err) {
    errors.push({ path: '', message: `validator error: ${(err as Error).message}` });
  }
  return { valid: errors.length === 0, errors };
}

/** One-line, model-friendly summary of validation errors for the repair loop. */
export function formatErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ');
}
