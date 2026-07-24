import type { CloudflareToken, TokenPolicy } from './creds-cloudflare-api';
import type { TokenCondition } from './creds-cloudflare-condition';
import type { DestinationFormat } from './creds-r2';

export type AccountToken = {
  readonly accountId: string;
  readonly token: CloudflareToken;
};

export type PlannedAction =
  | {
      readonly kind: 'revoke';
      readonly accountId: string;
      readonly tokenId: string;
      readonly name: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'renew';
      readonly accountId: string;
      readonly tokenId: string;
      readonly name: string;
      readonly target: string;
      readonly key: string;
      readonly format: DestinationFormat;
      readonly policies: ReadonlyArray<TokenPolicy>;
      readonly condition: TokenCondition | null;
      readonly replacementExpiresOn: string;
      readonly reason: string;
    };

export type CredsPlan = {
  readonly actions: ReadonlyArray<PlannedAction>;
  readonly findings: ReadonlyArray<string>;
  readonly healthy: number;
};
