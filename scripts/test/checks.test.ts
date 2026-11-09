import { beforeAll, describe, expect, it } from 'vitest';
import { checkSpec, specPrefix, type Finding } from '../specs/checks';
import { bundleSource, createSpecConfig } from '../specs/lint';
import { findSources } from '../specs/sources';
import { fixtureRoot } from './support';

// The tests reach into untyped spec documents to break them one rule at a time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

let docs: Record<'v0' | 'v1' | 'v2', Doc>;

beforeAll(async () => {
    const config = await createSpecConfig();
    const sources = await findSources(fixtureRoot);
    const load = async (prefix: number): Promise<Doc> => {
        const source = sources.find((s) => s.prefix === prefix);
        if (!source) throw new Error(`no fixture for v${prefix}`);
        return (await bundleSource(fixtureRoot, source, config)).parsed as Doc;
    };
    docs = { v0: await load(0), v1: await load(1), v2: await load(2) };
});

function rules(findings: Finding[]): string[] {
    return findings.map((finding) => finding.rule);
}

function renamePath(doc: Doc, from: string, to: string): void {
    doc['paths'] = Object.fromEntries(Object.entries(doc['paths']).map(([path, item]) => [path === from ? to : path, item]));
}

describe('checkSpec on the valid fixtures', () => {
    it.each(['v0', 'v1', 'v2'] as const)('finds nothing in %s', (name) => {
        expect(checkSpec(docs[name])).toEqual([]);
    });

    it('accepts a released 1.x version for /v1', () => {
        const doc = structuredClone(docs.v1);
        doc['info'].version = '1.2.0';
        expect(checkSpec(doc)).toEqual([]);
    });

    it('reads the prefix from the paths', () => {
        expect([docs.v0, docs.v1, docs.v2].map(specPrefix)).toEqual([0, 1, 2]);
        expect(specPrefix({ paths: { '/v1/a': {}, '/v2/b': {} } })).toBeUndefined();
        expect(specPrefix({ paths: { '/things': {} } })).toBeUndefined();
    });
});

const broken: [string, 'v0' | 'v1' | 'v2', (doc: Doc) => void, string][] = [
    ['openapi 3.1', 'v1', (d) => (d['openapi'] = '3.1.0'), 'openapi-version'],
    ['a non-semver version', 'v1', (d) => (d['info'].version = '1.0'), 'info-version'],
    ['a servers entry', 'v1', (d) => (d['servers'] = [{ url: 'https://x.test' }]), 'no-servers'],
    ['servers on an operation', 'v1', (d) => (d['paths']['/v1/things'].get.servers = [{ url: 'https://x.test' }]), 'no-servers'],
    ['a gateway extension', 'v1', (d) => (d['paths']['/v1/things'].get['x-amazon-apigateway-integration'] = {}), 'no-gateway-extensions'],
    ['a path without a prefix', 'v1', (d) => renamePath(d, '/v1/things', '/things'), 'version-prefix'],
    ['two prefixes in one spec', 'v1', (d) => (d['paths']['/v2/other'] = d['paths']['/v1/things']), 'version-prefix'],
    ['v1 paths with a 2.x version', 'v1', (d) => (d['info'].version = '2.0.0'), 'version-prefix'],
    ['v2 paths with a 1.x version', 'v2', (d) => (d['info'].version = '1.0.0'), 'version-prefix'],
    ['v0 paths with a 1.x version', 'v0', (d) => (d['info'].version = '1.0.0'), 'version-prefix'],
    ['a health route in a /v1 spec', 'v1', (d) => (d['paths']['/v1/health'] = d['paths']['/v1/things']), 'operational-routes'],
    ['a business route in a /v0 spec', 'v0', (d) => (d['paths']['/v0/things'] = d['paths']['/v0/version']), 'operational-routes'],
    ['a PascalCase operationId', 'v1', (d) => (d['paths']['/v1/things'].get.operationId = 'ListThings'), 'operation-id'],
    ['a one-word operationId', 'v1', (d) => (d['paths']['/v1/things'].get.operationId = 'things'), 'operation-id'],
    ['no tag', 'v1', (d) => delete d['paths']['/v1/things'].get.tags, 'one-tag'],
    ['two tags', 'v1', (d) => (d['paths']['/v1/things'].get.tags = ['things', 'extra']), 'one-tag'],
    ['the operations tag in a /v1 spec', 'v1', (d) => (d['paths']['/v1/things'].get.tags = ['operations']), 'one-tag'],
    ['a /v0 route without the operations tag', 'v0', (d) => (d['paths']['/v0/version'].get.tags = ['things']), 'one-tag'],
    ['a request body without an example', 'v1', (d) => delete d['paths']['/v1/things'].post.requestBody.content['application/json'].example, 'examples'],
    ['a response without an example', 'v1', (d) => delete d['paths']['/v1/things'].get.responses['200'].content['application/json'].example, 'examples'],
    ['a shared response without an example', 'v1', (d) => delete d['components'].responses.NotFound.content['application/json'].example, 'examples'],
    [
        'an inline schema on a 4xx response',
        'v1',
        (d) =>
            (d['paths']['/v1/things'].get.responses['400'] = {
                description: 'Bad',
                content: { 'application/json': { schema: { type: 'object' }, example: {} } }
            }),
        'problem-responses'
    ],
    ['a 4xx response without a body', 'v1', (d) => (d['paths']['/v1/things'].get.responses['4XX'] = { description: 'Bad' }), 'problem-responses'],
    ['a 503 response without the Problem schema', 'v0', (d) => (d['paths']['/v0/version'].get.responses['503'] = { description: 'Down' }), 'problem-responses'],
    ['an open health route that still needs a key', 'v0', (d) => delete d['paths']['/v0/health'].get.security, 'security'],
    ['a business route that is open', 'v1', (d) => (d['paths']['/v1/things'].get.security = []), 'security'],
    ['a business route with another security scheme', 'v1', (d) => (d['paths']['/v1/things'].get.security = [{ other: [] }]), 'security'],
    ['an apiKey scheme in the wrong header', 'v1', (d) => (d['components'].securitySchemes.apiKey.name = 'authorization'), 'security']
];

describe('checkSpec on broken variations', () => {
    it.each(broken)('flags %s', (_name, which, change, rule) => {
        const doc = structuredClone(docs[which]);
        change(doc);
        expect(rules(checkSpec(doc))).toContain(rule);
    });

    it('does not require a no-body response to have an example', () => {
        const doc = structuredClone(docs.v1);
        doc['paths']['/v1/things'].post.responses['204'] = { description: 'Done' };
        expect(checkSpec(doc)).toEqual([]);
    });

    it('warns about oneOf without a discriminator and accepts one with it', () => {
        const doc = structuredClone(docs.v1);
        doc['components'].schemas.Pet = { oneOf: [{ type: 'string' }, { type: 'integer' }] };
        expect(checkSpec(doc)).toEqual([expect.objectContaining({ rule: 'discriminator', severity: 'warn' })]);
        doc['components'].schemas.Pet.discriminator = { propertyName: 'kind' };
        expect(checkSpec(doc)).toEqual([]);
    });

    it('lets a v0 spec with only open routes omit the security scheme', () => {
        const doc = structuredClone(docs.v0);
        delete doc['paths']['/v0/health/ready'];
        delete doc['security'];
        delete doc['components'].securitySchemes;
        expect(checkSpec(doc)).toEqual([]);
    });
});
