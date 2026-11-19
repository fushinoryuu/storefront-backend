/** The environment variable that holds the addresses that receive alarm emails (docs/aws-setup.md). A deploy workflow sets it too, so it is never in a file. */
export const alarmRecipientsVariable = 'ALARM_RECIPIENTS';

export class InvalidAlarmRecipientError extends Error {}

/**
 * The addresses in a comma-separated list. Blank entries are dropped and a repeated address counts once.
 * An entry that is not an address is an error that does not repeat the entry, so a mistyped address is not printed into a log.
 */
export function parseAlarmRecipients(value: string | undefined): string[] {
    const addresses = (value ?? '')
        .split(',')
        .map((address) => address.trim())
        .filter((address) => address !== '');
    for (const address of addresses) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
            throw new InvalidAlarmRecipientError(`${alarmRecipientsVariable} has an entry that is not an email address. Use a comma-separated list, for example a@example.com,b@example.com.`);
        }
    }
    return [...new Set(addresses)];
}
