import { withRetry, NonRetryableError } from "../utils/retry.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const EARLY_EXPIRY_MARGIN_MS = 30_000;

interface TokenResponse {
  readonly access_token: string;
  readonly expires_in: number;
}

export class SpotifyAuthClient {
  private cachedToken: string | undefined;
  private expiresAtMs = 0;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.cachedToken && Date.now() < this.expiresAtMs) {
      return this.cachedToken;
    }
    return withRetry(
      async () => {
        const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString(
          "base64",
        );
        const response = await fetch(TOKEN_URL, {
          method: "POST",
          headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
          signal,
        });

        if (response.status === 400 || response.status === 401) {
          throw new NonRetryableError(
            `Spotify authentication rejected credentials (status ${response.status})`,
          );
        }
        if (!response.ok) {
          throw new Error(`Spotify token request failed with status ${response.status}`);
        }

        const body = (await response.json()) as TokenResponse;
        this.cachedToken = body.access_token;
        this.expiresAtMs = Date.now() + body.expires_in * 1000 - EARLY_EXPIRY_MARGIN_MS;
        return this.cachedToken;
      },
      { signal },
    );
  }
}
