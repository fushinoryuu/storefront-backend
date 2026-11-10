import type { z } from 'zod';

export type EventErrorCode = 'malformed_event' | 'unknown_event_type' | 'unsupported_schema_version';

// Thrown when an event cannot be built or parsed. `code` says why, and `issues` lists each problem as `path: message`.
// A consumer lets it reach the queue's redrive policy, so a bad event ends up in the DLQ instead of being dropped.
export class EventValidationError extends Error {
    readonly code: EventErrorCode;
    readonly issues: readonly string[];

    constructor(code: EventErrorCode, message: string, issues: readonly string[] = []) {
        super(issues.length > 0 ? `${message}: ${issues.join('; ')}` : message);
        this.name = 'EventValidationError';
        this.code = code;
        this.issues = issues;
    }
}

export function describeIssues(error: z.ZodError): string[] {
    return error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(event)'} ${issue.message}`);
}
