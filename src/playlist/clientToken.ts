import { randomBytes } from "node:crypto";
import { BROWSER_HEADERS } from "./embedPage.js";
import { NonRetryableError, withRetry } from "../utils/retry.js";

const CLIENT_TOKEN_URL = "https://clienttoken.spotify.com/v1/clienttoken";
const GRANTED_RESPONSE_TYPE = "RESPONSE_GRANTED_TOKEN_RESPONSE";
const DEFAULT_REFRESH_AFTER_SEC = 3600;
const REFRESH_MARGIN_MS = 60_000;

export const WEB_PLAYER_CLIENT_ID = "d8a5ed958d274c2e8ee717e6a4b0971d";
export const WEB_PLAYER_VERSION = "1.2.46.462.g7f6c1b0d";

interface GrantedTokenResponse {
  readonly response_type?: string;
  readonly granted_token?: {
    readonly token?: string;
    readonly refresh_after_seconds?: number;
    readonly expires_after_seconds?: number;
  };
}

export interface ClientTokenProvider {
  getClientToken(signal?: AbortSignal): Promise<string>;
  invalidate(): void;
}

export class SpotifyClientTokenProvider implements ClientTokenProvider {
  private readonly deviceId = randomBytes(16).toString("hex");
  private token: string | undefined;
  private refreshAtMs = 0;

  async getClientToken(signal?: AbortSignal): Promise<string> {
    if (this.token !== undefined && Date.now() < this.refreshAtMs) {
      return this.token;
    }

    const granted = await withRetry(
      async () => {
        const response = await fetch(CLIENT_TOKEN_URL, {
          method: "POST",
          headers: {
            ...BROWSER_HEADERS,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          signal,
          body: JSON.stringify({
            client_data: {
              client_version: WEB_PLAYER_VERSION,
              client_id: WEB_PLAYER_CLIENT_ID,
              js_sdk_data: {
                device_brand: "unknown",
                device_model: "unknown",
                os: "windows",
                os_version: "NT 10.0",
                device_id: this.deviceId,
                device_type: "computer",
              },
            },
          }),
        });

        if (!response.ok) {
          throw new Error(`Spotify client token request failed with status ${response.status}`);
        }

        const payload = (await response.json()) as GrantedTokenResponse;
        if (payload.response_type !== GRANTED_RESPONSE_TYPE || !payload.granted_token?.token) {
          throw new NonRetryableError(
            `Spotify refused to grant a client token (response_type: ${payload.response_type ?? "missing"})`,
          );
        }
        return payload.granted_token;
      },
      { signal },
    );

    const lifetimeSec =
      granted.refresh_after_seconds ?? granted.expires_after_seconds ?? DEFAULT_REFRESH_AFTER_SEC;
    this.token = granted.token as string;
    this.refreshAtMs = Date.now() + lifetimeSec * 1000 - REFRESH_MARGIN_MS;
    return this.token;
  }

  invalidate(): void {
    this.token = undefined;
    this.refreshAtMs = 0;
  }
}
