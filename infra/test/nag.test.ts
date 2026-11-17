import { App, Stack } from 'aws-cdk-lib';
import { CfnSecret } from 'aws-cdk-lib/aws-secretsmanager';
import { describe, expect, it } from 'vitest';
import { createApp } from '../lib/app';
import { stageNames } from '../lib/config/stages';
import { acknowledgements, applyNag } from '../lib/nag';

function appWithUnrotatedSecret() {
    const app = new App();
    new CfnSecret(new Stack(app, 'Demo'), 'Secret', {});
    return app;
}

describe('applyNag', () => {
    it('fails the synthesis on a finding that is not acknowledged', () => {
        const app = appWithUnrotatedSecret();
        applyNag(app, []);

        expect(() => app.synth()).toThrow(/AwsSolutions-SMG4/);
    });

    it('lets a finding through when it is acknowledged', () => {
        const app = appWithUnrotatedSecret();
        applyNag(app, [{ path: 'Demo/Secret', id: 'AwsSolutions::AwsSolutions-SMG4', reason: 'A test of an acknowledged finding.' }]);

        expect(() => app.synth()).not.toThrow();
    });

    it('fails when an acknowledgement names a construct that is not in its stack, so none goes stale', () => {
        const app = appWithUnrotatedSecret();

        expect(() => applyNag(app, [{ path: 'Demo/Gone', id: 'AwsSolutions::AwsSolutions-SMG4', reason: 'A test of a stale acknowledgement.' }])).toThrow(/Demo\/Gone/);
    });

    it('skips an acknowledgement of a stack that is not in the app', () => {
        const app = appWithUnrotatedSecret();

        expect(() => applyNag(app, [{ path: 'Other/Secret', id: 'AwsSolutions::AwsSolutions-SMG4', reason: 'A test of a stack that was not built.' }])).not.toThrow();
    });
});

describe('acknowledgements', () => {
    it('each give a reason of a full sentence', () => {
        for (const { reason } of acknowledgements) {
            expect(reason.length).toBeGreaterThan(40);
        }
    });

    it.each(stageNames)(
        'are all valid for the app of %s, which synthesizes with no other finding',
        (stage) => {
            expect(() => createApp({ context: { stage } }).synth()).not.toThrow();
        },
        30000
    );
});
