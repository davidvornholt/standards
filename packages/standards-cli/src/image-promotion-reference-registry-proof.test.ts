import { expect, it } from 'bun:test';
import process from 'node:process';
import { ACTUAL_UPSTREAM, runProcess } from './cli-test-support';
import {
  contract,
  DIGEST_A,
  DIGEST_B,
  environment,
} from './image-promotion-reference-contract-test-support';

const IMAGE = 'ghcr.io/example/app/web';
const prelude = `
read-provider-package-metadata() {
  if test "$PROVIDER_AVAILABLE" != true; then return 22; fi
  printf '{"imageRepository":"%s","visibility":"%s"}\n' "$PROVIDER_IMAGE" "$PROVIDER_VISIBILITY"
}
resolve-anonymous-digest() {
  if test "$1" != "$RESOLVER_IMAGE"; then return 23; fi
  if test "$ANONYMOUS_AVAILABLE" != true; then return 22; fi
  printf '%s\n' "$ANONYMOUS_DIGEST"
}
resolve-job-token-digest() {
  if test "$1" != "$RESOLVER_IMAGE"; then return 23; fi
  if test "$JOB_TOKEN_AVAILABLE" != true; then return 22; fi
  printf '%s\n' "$JOB_TOKEN_DIGEST"
}
`;

const runProof = ({
  access = 'private',
  anonymousAvailable = 'false',
  anonymousDigest = DIGEST_A,
  digest = DIGEST_A,
  image = IMAGE,
  jobTokenAvailable = 'true',
  jobTokenDigest = DIGEST_A,
  providerAvailable = 'true',
  providerImage = IMAGE,
  providerVisibility = 'private',
  resolverImage = IMAGE,
}: {
  readonly access?: string;
  readonly anonymousAvailable?: string;
  readonly anonymousDigest?: string;
  readonly digest?: string;
  readonly image?: string;
  readonly jobTokenAvailable?: string;
  readonly jobTokenDigest?: string;
  readonly providerAvailable?: string;
  readonly providerImage?: string;
  readonly providerVisibility?: string;
  readonly resolverImage?: string;
}) =>
  runProcess(
    'bash',
    ACTUAL_UPSTREAM,
    [
      '-c',
      `${prelude}\n${contract('registry-access-proof', 'sh')}`,
      'proof',
      image,
      digest,
      access,
    ],
    environment([
      ['ANONYMOUS_AVAILABLE', anonymousAvailable],
      ['ANONYMOUS_DIGEST', anonymousDigest],
      ['JOB_TOKEN_AVAILABLE', jobTokenAvailable],
      ['JOB_TOKEN_DIGEST', jobTokenDigest],
      ['PATH', process.env.PATH],
      ['PROVIDER_AVAILABLE', providerAvailable],
      ['PROVIDER_IMAGE', providerImage],
      ['PROVIDER_VISIBILITY', providerVisibility],
      ['RESOLVER_IMAGE', resolverImage],
    ]),
  );

it('binds public and private proof to the exact repository and digest', () => {
  expect(
    runProof({ access: 'public', anonymousAvailable: 'true' }).status,
  ).toBe(0);
  expect(runProof({}).status).toBe(0);
  for (const fixture of [
    { image: 'docker.io/example/app' },
    { resolverImage: 'ghcr.io/example/other' },
    { providerImage: 'ghcr.io/example/other' },
    { jobTokenDigest: DIGEST_B },
    { access: 'public', anonymousAvailable: 'true', anonymousDigest: DIGEST_B },
  ]) {
    expect(runProof(fixture).status).not.toBe(0);
  }
});

it('fails closed on public, internal, or unreadable private-package metadata', () => {
  for (const providerVisibility of ['public', 'internal']) {
    expect(runProof({ providerVisibility }).status).not.toBe(0);
  }
  expect(runProof({ providerAvailable: 'false' }).status).not.toBe(0);
});

it('requires anonymous denial and an authenticated exact-digest grant', () => {
  expect(runProof({ anonymousAvailable: 'true' }).status).not.toBe(0);
  expect(runProof({ jobTokenAvailable: 'false' }).status).not.toBe(0);
  expect(runProof({ access: 'legacy' }).status).not.toBe(0);
});
