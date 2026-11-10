import { Logger } from '@aws-lambda-powertools/logger';

// Services import this wrapper and never Powertools itself (decision 0010), so the standard keys and the redaction live here.

const redacted = '[REDACTED]';

// Fields that hold an email, a phone number or an address. Their value is never logged. Keys are compared without case, dashes or underscores.
const redactedKeys = new Set(['email', 'emailaddress', 'phone', 'phonenumber', 'address', 'addresses', 'shippingaddress', 'billingaddress', 'street', 'line1', 'line2', 'city', 'postalcode', 'zip', 'zipcode']);

// An email address that shows up inside a message or an error text.
const emailInText = /[\w.+%-]+@[\w-]+(?:\.[\w-]+)+/g;

/** The replacer the logger runs on every key and value before it writes a line. */
export function redact(key: string, value: unknown): unknown {
    if (value !== null && value !== undefined && redactedKeys.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) return redacted;
    if (typeof value === 'string') return value.replace(emailInText, redacted);
    return value;
}

export interface LoggerOptions {
    service: string;
    stage: string;
}

export interface RequestContext {
    correlationId: string;
    requestId: string;
}

export type LogFields = Record<string, unknown>;

/** Logs for one request. Put an `Error` in a field to log it with its stack. */
export interface RequestLogger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
}

export interface ServiceLogger {
    /** The only way to get a logger, so a line without a correlation id and a request id cannot be written. */
    forRequest(context: RequestContext): RequestLogger;
}

/** Create the logger of a service once per execution environment. Log level and sampling come from the `POWERTOOLS_LOG_LEVEL` environment variable. */
export function createLogger({ service, stage }: LoggerOptions): ServiceLogger {
    const root = new Logger({ serviceName: service, persistentKeys: { stage }, jsonReplacerFn: redact });
    return {
        forRequest({ correlationId, requestId }) {
            const logger = root.createChild({ persistentKeys: { correlationId, requestId } });
            return {
                debug: (message, fields = {}) => logger.debug(message, fields),
                info: (message, fields = {}) => logger.info(message, fields),
                warn: (message, fields = {}) => logger.warn(message, fields),
                error: (message, fields = {}) => logger.error(message, fields)
            };
        }
    };
}
