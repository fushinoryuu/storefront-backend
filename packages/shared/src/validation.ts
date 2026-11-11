import { z } from 'zod';
import { ValidationError, type FieldError } from './errors';

// Validation against the schemas generated from the specs (decision 0004, option d). Import them from `generated/<bundle>/zod.gen.ts` (run `npm run generate:schemas`), for example `zCreateOrderBody` and `zListOrdersQuery`.

/** A Zod issue path as the `field` of the spec's `FieldError`: `items[0].quantity`. An empty path is the value itself, which is called `root`. */
export function fieldPath(path: readonly PropertyKey[], root: string): string {
    const text = path.reduce<string>((acc, key) => (typeof key === 'number' ? `${acc}[${key}]` : `${acc}${acc === '' ? '' : '.'}${String(key)}`), '');
    return text === '' ? root : text;
}

function fieldErrors(error: z.ZodError, root: string): FieldError[] {
    return error.issues.map((issue) => ({ field: fieldPath(issue.path, root), message: issue.message }));
}

/** The parsed value, or a `ValidationError` (a 400) with one entry in `errors[]` for every field that is not valid. `root` names the input when the problem is the input as a whole. */
export function validate<S extends z.ZodType>(schema: S, input: unknown, root = 'body'): z.output<S> {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
    throw new ValidationError(fieldErrors(result.error, root));
}

/** The JSON of a request body. A missing body or text that is not JSON is a `ValidationError`, the same as a body that breaks the schema. */
export function parseJsonBody(raw: string | null | undefined): unknown {
    if (raw === null || raw === undefined || raw.trim() === '') {
        throw new ValidationError([{ field: 'body', message: 'is required' }]);
    }
    try {
        return JSON.parse(raw);
    } catch {
        throw new ValidationError([{ field: 'body', message: 'must be valid JSON' }]);
    }
}

function baseType(schema: z.core.$ZodType): string {
    let current = schema;
    for (;;) {
        const def = current._zod.def as { type: string; innerType?: z.core.$ZodType };
        if (def.innerType === undefined) return def.type;
        current = def.innerType;
    }
}

function coerce(type: string, value: string): unknown {
    if (type === 'number' && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
    if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
    return value;
}

/**
 * The parsed query string, path parameters or headers of a request. Their values arrive as text, so a value is turned into a number or a boolean when the schema asks for one (a text that is not a number stays text, and the schema reports it).
 * Only the names in the schema are read, and a header is found whatever its case.
 */
export function validateParameters<S extends z.ZodObject>(schema: S, values: Readonly<Record<string, string | undefined>> | null | undefined, root = 'parameters'): z.output<S> {
    const lower = new Map(Object.entries(values ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const input: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(schema.shape)) {
        const value = lower.get(name.toLowerCase());
        if (value !== undefined) input[name] = coerce(baseType(field), value);
    }
    return validate(schema, input, root);
}
