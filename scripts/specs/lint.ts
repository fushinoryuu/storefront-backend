import path from 'node:path';
import { bundle, createConfig, lint } from '@redocly/openapi-core';
import { checkSpec, specPrefix, type Finding } from './checks';
import { findSources, type Source } from './sources';

export type SpecConfig = Awaited<ReturnType<typeof createConfig>>;

/**
 * Redocly does the structural work: the OpenAPI schema, resolvable refs, unique operationIds and
 * examples that match their schemas. The project rules in checks.ts run on the bundled result.
 */
export function createSpecConfig(): Promise<SpecConfig> {
    return createConfig({
        extends: ['recommended'],
        rules: {
            'info-license': 'error',
            'no-empty-servers': 'off',
            'operation-4xx-response': 'off',
            'operation-operationId': 'error',
            'operation-operationId-unique': 'error',
            'operation-summary': 'error',
            'no-invalid-media-type-examples': 'error',
            'no-invalid-schema-examples': 'error',
            'no-unresolved-refs': 'error'
        }
    });
}

export async function bundleSource(rootDir: string, source: Source, config: SpecConfig): Promise<{ parsed: unknown; errors: string[] }> {
    const result = await bundle({ ref: path.join(rootDir, source.file), config });
    const errors = result.problems.filter((problem) => problem.severity === 'error').map((problem) => problem.message);
    return { parsed: result.bundle.parsed as unknown, errors };
}

export interface LintResult {
    source: Source;
    findings: Finding[];
}

export async function lintSpecs(rootDir: string): Promise<LintResult[]> {
    const config = await createSpecConfig();
    const results: LintResult[] = [];
    for (const source of await findSources(rootDir)) {
        const problems = await lint({ ref: path.join(rootDir, source.file), config });
        const findings: Finding[] = problems.map((problem) => ({
            rule: problem.ruleId,
            severity: problem.severity === 'error' ? 'error' : 'warn',
            message: problem.message,
            where: problem.location[0]?.pointer ?? '#/'
        }));
        const { parsed, errors } = await bundleSource(rootDir, source, config);
        for (const message of errors) {
            findings.push({ rule: 'bundle', severity: 'error', message, where: '#/' });
        }
        findings.push(...checkSpec(parsed));
        const prefix = specPrefix(parsed);
        if (prefix !== undefined && prefix !== source.prefix) {
            findings.push({
                rule: 'source-name',
                severity: 'error',
                message: `${source.file} holds /v${prefix} paths, but its name promises /v${source.prefix}.`,
                where: '#/paths'
            });
        }
        results.push({ source, findings });
    }
    return results;
}

export function formatResults(results: LintResult[]): string {
    const lines: string[] = [];
    for (const { source, findings } of results) {
        for (const finding of findings) {
            lines.push(`${source.file}: ${finding.severity} ${finding.rule}: ${finding.message} (${finding.where})`);
        }
    }
    return lines.join('\n');
}

export function hasErrors(results: LintResult[]): boolean {
    return results.some(({ findings }) => findings.some((finding) => finding.severity === 'error'));
}
