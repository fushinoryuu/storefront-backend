import { readdir } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_FILE = /^openapi(?:-v(\d+))?\.yaml$/;

export interface Source {
  /** Path from the repo root, with forward slashes. */
  file: string;
  service: string;
  /** The version prefix the file name promises: openapi.yaml is /v1, openapi-v2.yaml is /v2. */
  prefix: number;
}

/** Every `services/<service>/openapi*.yaml`, sorted. */
export async function findSources(rootDir: string): Promise<Source[]> {
  const servicesDir = path.join(rootDir, 'services');
  const services = await readdir(servicesDir, { withFileTypes: true }).catch(() => []);
  const sources: Source[] = [];
  for (const service of services.filter((entry) => entry.isDirectory())) {
    const names = await readdir(path.join(servicesDir, service.name));
    for (const name of names) {
      const match = SOURCE_FILE.exec(name);
      if (!match) continue;
      sources.push({
        file: `services/${service.name}/${name}`,
        service: service.name,
        prefix: match[1] === undefined ? 1 : Number(match[1]),
      });
    }
  }
  return sources.sort((a, b) => a.file.localeCompare(b.file));
}

export function bundleFileName(service: string, prefix: number): string {
  return `${service}-service-v${prefix}.yaml`;
}
