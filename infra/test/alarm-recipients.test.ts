import { describe, expect, it } from 'vitest';
import { InvalidAlarmRecipientError, parseAlarmRecipients } from '../lib/config/alarm-recipients';

describe('parseAlarmRecipients', () => {
    it.each([undefined, '', '  ', ' , ,'])('gives no address for %j', (value) => {
        expect(parseAlarmRecipients(value)).toEqual([]);
    });

    it('splits on commas, trims each entry and counts a repeated address once', () => {
        expect(parseAlarmRecipients(' one@example.com, two@example.com ,one@example.com,')).toEqual(['one@example.com', 'two@example.com']);
    });

    it.each(['not-an-address', 'one@example', 'one@@example.com', 'one two@example.com', 'a@example.com;b@example.com'])('rejects %j without repeating it in the message', (value) => {
        let error: unknown;
        try {
            parseAlarmRecipients(value);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(InvalidAlarmRecipientError);
        expect((error as Error).message).toMatch(/^ALARM_RECIPIENTS has an entry that is not an email address/);
        expect((error as Error).message).not.toContain(value);
    });
});
