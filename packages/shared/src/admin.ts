import { ForbiddenError } from './errors';

// Usage plans apply to a whole stage, not to a route, so API Gateway cannot let only the `admin` key call one route (decision 0005). The handler of that route checks the key itself.

/** What the check reads of an API Gateway proxy event: the id of the API key that made the request. It is the id, never the value. */
export interface AdminKeyEvent {
    readonly requestContext?: { readonly identity?: { readonly apiKeyId?: string | null } | null } | null;
}

/**
 * Throws `ForbiddenError` (403) unless the request was made with the `admin` API key. Call it first in the handler of an `adminOnly` route.
 * `adminKeyId` is the id of the platform stack's `admin` key, which a function gets from the SSM parameter `/storefront/<stage>/platform/admin-api-key-id`, as an environment variable (see the README).
 * A caller with another key, and a request with no key id in its context, are refused.
 * An `adminKeyId` that is empty is a mistake of the service and not of the caller, so it throws a plain `Error` (a 500 without detail), and never lets a request with no key id match it.
 */
export function requireAdminKey(event: AdminKeyEvent, adminKeyId: string | undefined): void {
    if (!adminKeyId) throw new Error('requireAdminKey needs the id of the admin API key, and got none. Pass it to the function as an environment variable.');
    const callerKeyId = event.requestContext?.identity?.apiKeyId;
    if (!callerKeyId || callerKeyId !== adminKeyId) throw new ForbiddenError();
}
