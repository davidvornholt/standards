def nonempty_string:
  type == "string" and length > 0;

if type != "object" then
  error("Bun system metadata must be a JSON object")
else
  .
end
| to_entries
| if length == 0 then
    error("Bun system metadata must define at least one system")
  else
    .
  end
| map(
    . as $entry
    | if (($entry.key | nonempty_string) and ($entry.key | test("^[A-Za-z0-9_+.-]+$"))) then
        .
      else
        error("Bun system metadata contains an invalid system key")
      end
    | if (.value | type == "object") then
        .
      else
        error("Bun system metadata for \(.key) must be an object")
      end
    | if ((.value.archivePlatform | nonempty_string) and (.value.archivePlatform | test("^[A-Za-z0-9_-]+$"))) then
        .
      else
        error("Bun system metadata for \(.key) has an invalid archivePlatform")
      end
    | if ((.value.archiveHash | nonempty_string) and (.value.archiveHash | test("^sha256-[A-Za-z0-9+/]{43}=$"))) then
        .
      else
        error("Bun system metadata for \(.key) has an invalid archiveHash")
      end
    | if ((.value.runner | nonempty_string) and (.value.runner | test("^ubuntu-[0-9]{2}\\.[0-9]{2}(-arm)?$"))) then
        {
          runner: .value.runner,
          system: .key
        }
      else
        error("Bun system metadata for \(.key) has an invalid native GitHub runner")
      end
  )
| sort_by(.system)
| { include: . }
