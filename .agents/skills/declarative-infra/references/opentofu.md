# OpenTofu reference implementations

Root stacks live under `opentofu/<stack>/` in the consuming repo. Each stack
owns its backend, provider configuration, credentials, and state — resources
are written inline; there are no shared child modules.

## Stack conventions

- One directory per stack, one state per directory. Commit
  `.terraform.lock.hcl`.
- Backend: `backend "s3" {}` with configuration and credentials injected by
  the workflow/environment (R2 is S3-compatible), never hardcoded.
- Providers configured empty (`provider "cloudflare" {}`); credentials come
  from the environment.
- Non-secret identifiers (zone IDs, account IDs, record contents) are plain
  `locals` — they are not secrets, and inline values keep plans reviewable.

```hcl
terraform {
  required_version = ">= 1.10.0"

  backend "s3" {}

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {}
```

## Cloudflare DNS records

One `for_each` resource over a map keyed by a stable identifier — renaming a
key is a `moved` block, not a destroy/create. Defaults: `ttl = 1` (auto),
`proxied = false`.

```hcl
locals {
  zone_id = "..."

  dns_records = {
    apex_a   = { name = "example.com", type = "A", content = "203.0.113.7", proxied = true }
    server_a = { name = "server.example.com", type = "A", content = "203.0.113.7" }
    mx       = { name = "example.com", type = "MX", content = "mail.example.com", priority = 10 }
  }
}

resource "cloudflare_dns_record" "managed" {
  for_each = local.dns_records

  zone_id  = local.zone_id
  name     = each.value.name
  type     = each.value.type
  content  = try(each.value.content, null)
  ttl      = try(each.value.ttl, 1)
  proxied  = try(each.value.proxied, false)
  priority = try(each.value.priority, null)
  data     = try(each.value.data, null) # SRV-style records
}
```

## Cloudflare R2 buckets

`prevent_destroy` guards data: removing a bucket is a deliberate two-step
(lift the guard, then destroy), never a plan side effect.

```hcl
resource "cloudflare_r2_bucket" "bucket" {
  for_each = {
    app = { name = "my-app-media", jurisdiction = "eu" }
  }

  account_id    = local.account_id
  name          = each.value.name
  jurisdiction  = try(each.value.jurisdiction, null)
  location      = try(each.value.location, null)
  storage_class = try(each.value.storage_class, "Standard")

  lifecycle {
    prevent_destroy = true
  }
}
```

## Adopting or restructuring resources

- Existing cloud resources enter state through `import` blocks; refactors
  move addresses with `moved` blocks. Both stay in the repo as history.
- Any migration — including inlining a retired
  `davidvornholt/declarative-infra` child module (address
  `module.<name>.cloudflare_*` → `cloudflare_*`) — must produce a **no-op
  plan** before it merges.
