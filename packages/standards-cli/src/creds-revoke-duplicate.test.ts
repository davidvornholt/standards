import { afterEach, expect, it, spyOn } from 'bun:test';
import {
  ACCOUNT_A,
  cleanupCredsAdd,
  initializeConsumer,
  installSops,
  pageInfo,
  response,
} from './creds-add-test-support';
import { runCredsCommand } from './creds-commands';

const ID_LENGTH = 32;
const TOKEN_COUNT = 3;
const BOOTSTRAP = 'a'.repeat(ID_LENGTH);
const STORED = 'b'.repeat(ID_LENGTH);
const OLD = 'c'.repeat(ID_LENGTH);
const TOKEN = 'synthetic-stored-token';
const SECRET_LENGTH = 64;
const SECRET = 'd'.repeat(SECRET_LENGTH);
const NAME = 'standards/davidvornholt/example/ci/ci.token';
afterEach(cleanupCredsAdd);

const stub = (): Array<string> => {
  const deleted: Array<string> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/verify')) {
      const isStored =
        new Headers(init?.headers).get('authorization') === `Bearer ${TOKEN}`;
      return Promise.resolve(
        response({ id: isStored ? STORED : BOOTSTRAP, status: 'active' }),
      );
    }
    if (init?.method === 'DELETE') {
      deleted.push(url.split('/').at(-1) ?? '');
      return Promise.resolve(response({ id: OLD }));
    }
    return Promise.resolve(
      response(
        [
          { id: BOOTSTRAP, name: 'standards-broker', status: 'active' },
          { id: STORED, name: NAME, status: 'active' },
          { id: OLD, name: NAME, status: 'active' },
        ],
        pageInfo(TOKEN_COUNT, TOKEN_COUNT),
      ),
    );
  }) as typeof fetch;
  return deleted;
};

it.each(['bearer', 's3', 'missing'])(
  'retires only the explicitly selected unused duplicate for %s credentials',
  async (format) => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const deleted = stub();
    const doc =
      format === 'missing'
        ? { ci: {} }
        : {
            ci: {
              token:
                format === 'bearer'
                  ? TOKEN
                  : Object.fromEntries([
                      ['access_key_id', STORED],
                      ['secret_access_key', SECRET],
                    ]),
            },
          };
    installSops(`if [ "$1" = --decrypt ]; then printf '%s' '${JSON.stringify(doc)}'; exit 0; fi
case "$3" in
  *access_key_id*) printf '%s' '${STORED}' ;;
  *secret_access_key*) printf '%s' '${SECRET}' ;;
  *) printf '%s' '${TOKEN}' ;;
esac`);
    spyOn(console, 'log').mockImplementation(() => undefined);
    expect(
      await runCredsCommand(['revoke', '--dir', consumer, '--token-id', OLD]),
    ).toBe(true);
    expect(deleted).toEqual([OLD]);
  },
);

it.each([STORED, 'unreadable', 'changed'])(
  'keeps all tokens when requested duplicate is stored or cannot be identified: %s',
  async (requested) => {
    const consumer = initializeConsumer([ACCOUNT_A]);
    const deleted = stub();
    installSops(
      requested === 'unreadable'
        ? 'exit 1'
        : `if [ "$1" = --decrypt ]; then printf '%s' '{"ci":{"token":"${TOKEN}"}}'; else printf '%s' 'changed-value'; fi`,
    );
    spyOn(console, 'error').mockImplementation(() => undefined);
    expect(
      await runCredsCommand([
        'revoke',
        '--dir',
        consumer,
        '--token-id',
        requested === STORED ? STORED : OLD,
      ]),
    ).toBe(false);
    expect(deleted).toEqual([]);
  },
);
