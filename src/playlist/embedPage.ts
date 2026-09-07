import { withRetry, NonRetryableError } from "../utils/retry.js";

export const EMBED_BASE = "https://open.spotify.com/embed";

export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

const NEXT_DATA_PATTERN = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s;

export interface EmbedSession {
  readonly accessToken: string;
  readonly accessTokenExpirationTimestampMs: number;
  readonly isAnonymous: boolean;
}

interface EmbedNextData<T> {
  readonly props: {
    readonly pageProps: {
      readonly state: {
        readonly settings?: { readonly session?: EmbedSession };
        readonly data: { readonly entity: T };
      };
    };
  };
}

export interface EmbedPage<T> {
  readonly entity: T;
  readonly session: EmbedSession | undefined;
}

export async function fetchEmbedPage<T>(
  url: string,
  signal?: AbortSignal,
): Promise<EmbedPage<T>> {
  return withRetry(
    async () => {
      const response = await fetch(url, { headers: BROWSER_HEADERS, signal });

      if (response.status === 404) {
        throw new NonRetryableError(`Spotify page not found or not public (url: ${url})`);
      }
      if (!response.ok) {
        throw new Error(`Spotify embed page request failed with status ${response.status}`);
      }

      const html = await response.text();
      const match = NEXT_DATA_PATTERN.exec(html);
      if (!match?.[1]) {
        throw new NonRetryableError(
          `Could not find embedded data in Spotify page (url: ${url}). The page format may have changed.`,
        );
      }

      let parsed: EmbedNextData<T>;
      try {
        parsed = JSON.parse(match[1]) as EmbedNextData<T>;
      } catch {
        throw new NonRetryableError(`Spotify embed page returned invalid JSON (url: ${url})`);
      }

      const session = parsed.props.pageProps.state.settings?.session;
      return {
        entity: parsed.props.pageProps.state.data.entity,
        session: session?.accessToken ? session : undefined,
      };
    },
    { signal },
  );
}
