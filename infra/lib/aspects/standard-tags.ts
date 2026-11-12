import { Aspects, TagManager } from 'aws-cdk-lib';
import type { IAspect } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { ServiceName, SharedStackName, StageConfig, StageName } from '../config/stages';

export const projectTag = 'storefront';

/** What the tags need to know: the stage (`shared` for a stack that belongs to no stage) and the owner. */
export type TagContext = Pick<StageConfig, 'owner'> & { readonly name: StageName | 'shared' };

/** Adds the `project`, `stage`, `service` and `owner` tags to every taggable resource. */
export class StandardTags implements IAspect {
    private readonly tags: Readonly<Record<string, string>>;

    constructor(config: TagContext, service: ServiceName | SharedStackName) {
        this.tags = {
            project: projectTag,
            stage: config.name,
            service,
            owner: config.owner
        };
    }

    visit(node: IConstruct): void {
        if (!TagManager.isTaggable(node)) return;
        for (const [key, value] of Object.entries(this.tags)) {
            node.tags.setTag(key, value);
        }
    }
}

export function applyStandardTags(scope: IConstruct, config: TagContext, service: ServiceName | SharedStackName) {
    Aspects.of(scope).add(new StandardTags(config, service));
}
