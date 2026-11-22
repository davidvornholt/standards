# @davidvornholt/standards

Copies the agent rules, skills, and quality configuration of [davidvornholt/standards](https://github.com/davidvornholt/standards) into a repository, keeps them up to date, and reports synced files that were edited by hand. It runs on Bun. To try the language-neutral core files in any Git repository:

```sh
echo '{ "payload": "core", "autoSync": false }' > sync-standards.local.json
bunx @davidvornholt/standards init
bash .agents/skills/standards-sync/scripts/standards.sh check
```

To adopt the Bun payload or the automatic sync, follow the [adoption guide](https://github.com/davidvornholt/standards/blob/main/docs/adoption.md). After `init`, run the CLI as `bash .agents/skills/standards-sync/scripts/standards.sh`, which runs the standards commit that `sync-standards.lock` records, the one CI runs. For commands and options, run `bash .agents/skills/standards-sync/scripts/standards.sh help`, or, in a Bun workspace that depends on the package, `bun standards help`, `bun standards creds help`, `bun standards screenshots help`, or `bun standards land --help`.

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
