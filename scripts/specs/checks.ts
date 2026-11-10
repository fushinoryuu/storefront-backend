/**
 * Project rules for the OpenAPI specs (docs/spec-conventions.md). Each rule is a plain check over
 * a bundled document, so it is easy to test without a linter. Structural validation, operationId
 * uniqueness and example validation come from Redocly (see lint.ts).
 */

export type Severity = 'error' | 'warn';

export interface Finding {
    rule: string;
    severity: Severity;
    message: string;
    /** JSON pointer into the bundled document. */
    where: string;
}

type Json = Record<string, unknown>;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const PREFIX = /^\/v(\d+)(?:\/|$)/;
const OPERATIONAL_PATH = /^\/v\d+\/(?:health(?:\/ready)?|version)$/;
const V0_PATHS = new Set(['/v0/health', '/v0/health/ready', '/v0/version']);
const OPEN_PATHS = new Set(['/v0/health', '/v0/version']);
const OPERATION_ID = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;
const PROBLEM_REF = '#/components/schemas/Problem';

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pointer(...segments: string[]): string {
    return `#/${segments.map((s) => s.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

/** Follows local `$ref`s. Bundled documents have no other kind. */
function resolve(doc: Json, node: unknown): Json | undefined {
    let current = node;
    for (let depth = 0; depth < 10; depth++) {
        if (!isObject(current)) return undefined;
        const ref = current['$ref'];
        if (typeof ref !== 'string') return current;
        if (!ref.startsWith('#/')) return undefined;
        current = ref
            .slice(2)
            .split('/')
            .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))
            .reduce<unknown>((value, key) => (isObject(value) ? value[key] : undefined), doc);
    }
    return undefined;
}

/** The version prefix shared by all paths of a spec, or undefined if there is none or several. */
export function specPrefix(doc: unknown): number | undefined {
    if (!isObject(doc) || !isObject(doc['paths'])) return undefined;
    const prefixes = new Set(Object.keys(doc['paths']).map((path) => PREFIX.exec(path)?.[1] ?? 'none'));
    const [only] = [...prefixes];
    return prefixes.size === 1 && only !== 'none' ? Number(only) : undefined;
}

interface Operation {
    path: string;
    prefix: number | undefined;
    op: Json;
    where: string;
}

function operations(doc: Json, out: Finding[]): Operation[] {
    const found: Operation[] = [];
    const paths = isObject(doc['paths']) ? doc['paths'] : {};
    for (const [path, rawItem] of Object.entries(paths)) {
        const item = resolve(doc, rawItem);
        if (!item) continue;
        if ('servers' in item) {
            out.push({
                rule: 'no-servers',
                severity: 'error',
                message: 'Specs have no servers entry. Base URLs come from the stage manifest.',
                where: pointer('paths', path, 'servers')
            });
        }
        for (const method of METHODS) {
            const op = item[method];
            if (!isObject(op)) continue;
            const prefix = PREFIX.exec(path)?.[1];
            found.push({
                path,
                prefix: prefix === undefined ? undefined : Number(prefix),
                op,
                where: pointer('paths', path, method)
            });
        }
    }
    return found;
}

function error(rule: string, message: string, where: string): Finding {
    return { rule, severity: 'error', message, where };
}

function checkDocument(doc: Json, out: Finding[]): number | undefined {
    if (doc['openapi'] !== '3.0.3') {
        out.push(error('openapi-version', 'openapi must be 3.0.3.', pointer('openapi')));
    }
    if ('servers' in doc) {
        out.push(error('no-servers', 'Specs have no servers entry. Base URLs come from the stage manifest.', pointer('servers')));
    }
    const version = isObject(doc['info']) ? doc['info']['version'] : undefined;
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
        out.push(error('info-version', 'info.version must look like 1.2.3.', pointer('info')));
        return undefined;
    }
    return Number(version.split('.')[0]);
}

function checkPrefixes(doc: Json, major: number | undefined, out: Finding[]): void {
    const paths = isObject(doc['paths']) ? Object.keys(doc['paths']) : [];
    const prefixes = new Set<number>();
    for (const path of paths) {
        const match = PREFIX.exec(path);
        if (match?.[1] === undefined) {
            out.push(error('version-prefix', `${path} must start with /v<N>.`, pointer('paths', path)));
            continue;
        }
        const prefix = Number(match[1]);
        prefixes.add(prefix);
        const operational = OPERATIONAL_PATH.test(path);
        if (operational && prefix !== 0) {
            out.push(error('operational-routes', `${path}: health and version routes belong in the /v0 spec.`, pointer('paths', path)));
        }
        if (prefix === 0 && !V0_PATHS.has(path)) {
            out.push(error('operational-routes', `${path}: a /v0 spec contains only /v0/health, /v0/health/ready and /v0/version.`, pointer('paths', path)));
        }
    }
    if (prefixes.size > 1) {
        out.push(error('version-prefix', 'One spec has one version prefix.', pointer('paths')));
    }
    const [prefix] = [...prefixes];
    if (prefixes.size !== 1 || prefix === undefined || major === undefined) return;
    const agrees = prefix === 0 ? major === 0 : prefix === 1 ? major <= 1 : major === prefix;
    if (!agrees) {
        out.push(error('version-prefix', `The /v${prefix} prefix does not agree with the info.version major ${major}.`, pointer('info', 'version')));
    }
}

function checkSecurityScheme(doc: Json, out: Finding[]): void {
    const components = isObject(doc['components']) ? doc['components'] : {};
    const schemes = isObject(components['securitySchemes']) ? components['securitySchemes'] : {};
    const scheme = schemes['apiKey'];
    const valid = isObject(scheme) && scheme['type'] === 'apiKey' && scheme['in'] === 'header' && scheme['name'] === 'x-api-key';
    if (!valid) {
        out.push(error('security', 'components.securitySchemes.apiKey must be an apiKey in the x-api-key header.', pointer('components', 'securitySchemes', 'apiKey')));
    }
}

function checkSecurity(doc: Json, { path, op, where }: Operation, out: Finding[]): void {
    if (OPEN_PATHS.has(path)) {
        const open = Array.isArray(op['security']) && op['security'].length === 0;
        if (!open) out.push(error('security', `${path} must declare security: [].`, where));
        return;
    }
    const effective = op['security'] ?? doc['security'];
    const keyed = Array.isArray(effective) && effective.length > 0 && effective.every((requirement) => isObject(requirement) && 'apiKey' in requirement);
    if (!keyed) out.push(error('security', `${path} must require the apiKey scheme.`, where));
}

function checkOperation(doc: Json, operation: Operation, out: Finding[]): void {
    const { path, prefix, op, where } = operation;
    const id = op['operationId'];
    if (typeof id !== 'string' || !OPERATION_ID.test(id)) {
        out.push(error('operation-id', 'operationId must be camelCase, a verb plus a noun.', `${where}/operationId`));
    }
    const tags = op['tags'];
    if (!Array.isArray(tags) || tags.length !== 1) {
        out.push(error('one-tag', 'An operation has exactly one tag.', `${where}/tags`));
    } else if ((tags[0] === 'operations') !== (prefix === 0)) {
        out.push(error('one-tag', 'The operations tag is for /v0 routes, and only for them.', `${where}/tags`));
    }
    checkSecurity(doc, operation, out);
    if ('servers' in op) {
        out.push(error('no-servers', `${path} has its own servers entry.`, `${where}/servers`));
    }
    checkExamples(doc, op, where, out);
    checkProblems(doc, op, where, out);
}

function checkExamples(doc: Json, op: Json, where: string, out: Finding[]): void {
    const check = (holder: unknown, at: string): void => {
        const content = resolve(doc, holder)?.['content'];
        if (!isObject(content)) return;
        for (const [mediaType, media] of Object.entries(content)) {
            const hasExample = isObject(media) && (media['example'] !== undefined || (isObject(media['examples']) && Object.keys(media['examples']).length > 0));
            if (!hasExample) {
                out.push(error('examples', `${mediaType} needs an example.`, `${at}/content`));
            }
        }
    };
    check(op['requestBody'], `${where}/requestBody`);
    const responses = isObject(op['responses']) ? op['responses'] : {};
    for (const [code, response] of Object.entries(responses)) {
        check(response, `${where}/responses/${code}`);
    }
}

function checkProblems(doc: Json, op: Json, where: string, out: Finding[]): void {
    const responses = isObject(op['responses']) ? op['responses'] : {};
    for (const [code, response] of Object.entries(responses)) {
        if (!/^4(?:\d\d|XX)$/.test(code) && code !== '500' && code !== '503') continue;
        const content = resolve(doc, response)?.['content'];
        const schema = isObject(content) ? content['application/json'] : undefined;
        const ref = isObject(schema) && isObject(schema['schema']) ? schema['schema']['$ref'] : undefined;
        if (ref !== PROBLEM_REF) {
            out.push(error('problem-responses', `The ${code} response must be application/json with the Problem schema.`, `${where}/responses/${code}`));
        }
    }
}

/** Deep scan: gateway extensions anywhere, and oneOf/anyOf without a discriminator. */
function scan(node: unknown, at: string, out: Finding[]): void {
    if (Array.isArray(node)) {
        node.forEach((item, index) => scan(item, `${at}/${index}`, out));
        return;
    }
    if (!isObject(node)) return;
    if (('oneOf' in node || 'anyOf' in node) && !('discriminator' in node)) {
        out.push({
            rule: 'discriminator',
            severity: 'warn',
            message: 'oneOf and anyOf need a discriminator.',
            where: at
        });
    }
    for (const [key, value] of Object.entries(node)) {
        const child = `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
        if (key.startsWith('x-amazon-apigateway')) {
            out.push(error('no-gateway-extensions', `${key} is an API Gateway extension.`, child));
        }
        scan(value, child, out);
    }
}

export function checkSpec(input: unknown): Finding[] {
    if (!isObject(input)) return [error('openapi-version', 'The spec is not an object.', '#/')];
    const out: Finding[] = [];
    const major = checkDocument(input, out);
    checkPrefixes(input, major, out);
    const all = operations(input, out);
    const usesKey = all.some(({ path }) => !OPEN_PATHS.has(path)) || Boolean(input['security']);
    if (usesKey) checkSecurityScheme(input, out);
    for (const operation of all) checkOperation(input, operation, out);
    scan(input, '#', out);
    return out;
}
