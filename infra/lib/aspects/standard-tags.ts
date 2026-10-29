import { Aspects, TagManager } from 'aws-cdk-lib';
import type { IAspect } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { ServiceName, StageConfig } from '../config/stages';

export const projectTag = 'storefront';

/** Adds the `project`, `stage`, `service` and `owner` tags to every taggable resource. */
export class StandardTags implements IAspect {
  private readonly tags: Readonly<Record<string, string>>;

  constructor(config: StageConfig, service: ServiceName) {
    this.tags = {
      project: projectTag,
      stage: config.name,
      service,
      owner: config.owner,
    };
  }

  visit(node: IConstruct): void {
    if (!TagManager.isTaggable(node)) return;
    for (const [key, value] of Object.entries(this.tags)) {
      node.tags.setTag(key, value);
    }
  }
}

export function applyStandardTags(scope: IConstruct, config: StageConfig, service: ServiceName) {
  Aspects.of(scope).add(new StandardTags(config, service));
}
