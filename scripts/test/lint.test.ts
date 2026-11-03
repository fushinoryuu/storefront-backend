import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasErrors, lintSpecs } from '../specs/lint';
import { fixtureCopies, fixtureRoot } from './support';

const fx = fixtureCopies();

afterEach(() => fx.cleanup());

describe('lintSpecs', () => {
  it('passes the valid fixture repo', async () => {
    const results = await lintSpecs(fixtureRoot);
    expect(results.map(({ source }) => source.file)).toEqual([
      'services/demo/openapi-v0.yaml',
      'services/demo/openapi-v2.yaml',
      'services/demo/openapi.yaml',
    ]);
    expect(results.flatMap(({ findings }) => findings)).toEqual([]);
    expect(hasErrors(results)).toBe(false);
  });

  it('returns nothing for a repo without specs', async () => {
    expect(await lintSpecs(path.join(fixtureRoot, 'specs'))).toEqual([]);
  });

  it('reports a name that promises another prefix', async () => {
    const dir = await fx.edited('services/demo/openapi-v2.yaml', (text) =>
      text.replace('/v2/things', '/v1/things').replace('2.0.0', '1.0.0'),
    );
    const rules = (await lintSpecs(dir)).flatMap(({ findings }) => findings.map((f) => f.rule));
    expect(rules).toContain('source-name');
  });

  it('reports a missing summary through Redocly', async () => {
    const dir = await fx.edited('services/demo/openapi.yaml', (text) =>
      text.replace('      summary: Get a thing\n', ''),
    );
    const results = await lintSpecs(dir);
    const rules = results.flatMap(({ findings }) => findings.map((f) => f.rule));
    expect(rules).toContain('operation-summary');
    expect(hasErrors(results)).toBe(true);
  });

  it('reports a duplicate operationId through Redocly', async () => {
    const dir = await fx.edited('services/demo/openapi.yaml', (text) =>
      text.replace('operationId: getThing', 'operationId: listThings'),
    );
    const rules = (await lintSpecs(dir)).flatMap(({ findings }) => findings.map((f) => f.rule));
    expect(rules).toContain('operation-operationId-unique');
  });

  it('reports an example that does not match its schema', async () => {
    const dir = await fx.edited('services/demo/openapi.yaml', (text) =>
      text.replace(
        "                name: Widget\n        '400'",
        "                name: 5\n        '400'",
      ),
    );
    const rules = (await lintSpecs(dir)).flatMap(({ findings }) => findings.map((f) => f.rule));
    expect(rules).toContain('no-invalid-media-type-examples');
  });

  it('reports a reference that does not resolve', async () => {
    const dir = await fx.edited('services/demo/openapi.yaml', (text) =>
      text.replace('components/responses/NotFound', 'components/responses/Missing'),
    );
    const rules = (await lintSpecs(dir)).flatMap(({ findings }) => findings.map((f) => f.rule));
    expect(rules).toContain('no-unresolved-refs');
  });
});
