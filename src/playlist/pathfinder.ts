import type { Logger } from "../utils/logger.js";
import { NonRetryableError } from "../utils/retry.js";
import { BROWSER_HEADERS } from "./embedPage.js";
import { WEB_PLAYER_VERSION, type ClientTokenProvider } from "./clientToken.js";
import type { PathfinderOperation, QueryHashProvider } from "./queryHash.js";

const PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v1/query";
const MAX_ATTEMPTS = 3;

export interface PathfinderContext {
  readonly getAccessToken: (forceRefresh: boolean, signal?: AbortSignal) => Promise<string>;
  readonly clientTokens: ClientTokenProvider;
  readonly hashes: QueryHashProvider;
  readonly logger: Logger;
}

interface PathfinderResponse {
  readonly errors?: readonly { readonly message?: string }[];
  readonly data?: unknown;
}

function buildUrl(operation: PathfinderOperation, variables: object, hash: string): string {
  const extensions = { persistedQuery: { version: 1, sha256Hash: hash } };
  return (
    `${PATHFINDER_URL}?operationName=${operation}` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(JSON.stringify(extensions))}`
  );
}

function isPersistedQueryError(payload: PathfinderResponse): boolean {
  return (payload.errors ?? []).some((entry) =>
    (entry.message ?? "").toLowerCase().includes("persistedquerynotfound"),
  );
}

export async function pathfinderQuery(
  context: PathfinderContext,
  operation: PathfinderOperation,
  variables: object,
  signal?: AbortSignal,
): Promise<unknown> {
  let forceTokenRefresh = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const accessToken = await context.getAccessToken(forceTokenRefresh, signal);
    const clientToken = await context.clientTokens.getClientToken(signal);
    const response = await fetch(buildUrl(operation, variables, context.hashes.get(operation)), {
      signal,
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "client-token": clientToken,
        "app-platform": "WebPlayer",
        "spotify-app-version": WEB_PLAYER_VERSION,
      },
    });

    if (response.status === 401 || response.status === 403) {
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`Spotify rejected the anonymous session (status ${response.status})`);
      }
      context.logger.debug(`${operation}: status ${response.status}, refreshing tokens`);
      context.clientTokens.invalidate();
      forceTokenRefresh = true;
      continue;
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after") ?? "?";
      throw new NonRetryableError(`Spotify is rate limiting this client (retry after ${retryAfter}s)`);
    }
    if (!response.ok) {
      throw new Error(`Spotify ${operation} request failed with status ${response.status}`);
    }

    const payload = (await response.json()) as PathfinderResponse;
    if (isPersistedQueryError(payload)) {
      const refreshed = attempt < MAX_ATTEMPTS ? await context.hashes.refresh(operation, signal) : undefined;
      if (refreshed !== undefined) {
        context.logger.debug(`${operation}: query hash rotated, retrying with ${refreshed}`);
        continue;
      }
      throw new NonRetryableError(
        `Spotify no longer accepts the ${operation} query and no replacement hash was found`,
      );
    }
    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors.map((entry) => entry.message ?? "unknown").join("; ");
      throw new Error(`Spotify ${operation} returned errors: ${message}`);
    }
    return payload.data;
  }

  throw new Error(`Spotify ${operation} request exhausted its attempts`);
}
