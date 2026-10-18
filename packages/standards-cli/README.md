# @davidvornholt/standards

Initializes, synchronizes, and validates repositories that consume [davidvornholt/standards](https://github.com/davidvornholt/standards). To adopt it, follow the [adoption guide](https://github.com/davidvornholt/standards/blob/main/docs/adoption.md). For commands and options, run `bun standards help`, `bun standards creds help`, or `bun standards screenshots help`.

## Brokered S3 pairs from another repository

A plain `dev-env` layer can reference a broker-owned S3 pair that lives in another repository's SOPS target by adding `source`:

```yaml
apps:
  web:
    S3_ACCESS_KEY_ID:
      brokeredS3: garage
      key: garage.development
      part: access_key_id
      source:
        repository: owner/source
        checkout: ../source
```

Authorize it in the encrypted `secrets/dev.yaml` with the entry `owner/source@garage:garage.development` under `brokeredReferences`. `checkout` is resolved from the consumer root and must be a checkout of that repository; put machine-specific paths in the ignored `config/dev.local.yaml`. The command verifies the checkout's `origin`, but it does not protect against an untrusted local Git configuration. Rotating the pair in the source repository does not regenerate consumer environments: after updating the source checkout, run `bun standards dev-env` in each consumer on each machine.
