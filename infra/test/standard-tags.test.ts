import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { describe, expect, it } from 'vitest';
import { applyStandardTags } from '../lib/aspects/standard-tags';
import { stages } from '../lib/config/stages';
import { stackName } from '../lib/naming';

describe('StandardTags', () => {
  it('adds project, stage, service and owner tags to a resource', () => {
    const config = stages.dev;
    const stack = new Stack(new App(), 'Test', { stackName: stackName(config, 'Customers') });
    new Topic(stack, 'Sample');
    applyStandardTags(stack, config, 'Customers');

    const topics = Template.fromStack(stack).findResources('AWS::SNS::Topic');
    const tags = Object.values(topics)[0]?.Properties.Tags as { Key: string; Value: string }[];

    expect(Object.fromEntries(tags.map(({ Key, Value }) => [Key, Value]))).toEqual({
      project: 'storefront',
      stage: 'dev',
      service: 'Customers',
      owner: config.owner,
    });
  });
});
