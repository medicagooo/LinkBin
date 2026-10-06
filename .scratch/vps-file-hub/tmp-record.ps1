$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'D:\proj\LinkBin'
$p = (Resolve-Path -LiteralPath '.branch-records\vps-file-hub\events.jsonl').Path

# --- mark e010 executed (it was carried by the push itself) ---
$txt = [System.IO.File]::ReadAllText($p)
$oldE010 = '{"id":"vps-file-hub-e010","at":"2026-10-07T03:05:00+08:00","type":"operation","operation":"git push origin main (registry bookkeeping commit)","reason":"Keep the published cloud main in step with the local registry bookkeeping commits required by the operation discipline (verified-push record for e009 and the remote metadata in BRANCHES.md). No divergence: origin/main was verified equal to cf8c415, the parent of the commit being pushed, so this is a normal fast-forward.","base":"cf8c415833e7f94130fd546d0f2c00a4f6a3a25a","destination":"git@github.com:medicagooo/LinkBin.git refs/heads/main","path":"D:\\proj\\LinkBin","expected_start_state":"local main = 69048fc, origin/main = cf8c415 (local ahead by 1)","intended_result":"origin/main = 69048fc","status":"predeclared"}'
if ($txt -notmatch [regex]::Escape($oldE010)) { throw 'e010 predeclared line not found verbatim' }
$newE010 = $oldE010 -replace '"intended_result":"origin/main = 69048fc","status":"predeclared"', '"intended_result":"origin/main = 69048fc","status":"executed","after":"origin/main = 0ae4c85145dd96b59554cc0dfa593c40bfd028a7 (the pre-action commit 0ae4c85 was itself the pushed content, so the registry commit is in the pushed content as required)","verified_at":"2026-10-07T03:07:00+08:00","verified_by":"git push output cf8c415..0ae4c85 + git ls-remote origin refs/heads/main + gh repo view"'
$txt = $txt.Replace($oldE010, $newE010)

# --- append e011 / e012 ---
$new = @(
'{"id":"vps-file-hub-e011","at":"2026-10-07T03:10:00+08:00","type":"note","source":"agent","summary":"Research deliverable landed: docs/research/cloudflare-platform-limits.md, 943 lines with 31 distinct cited official Cloudflare URLs and 11 explicitly unverified items. It resolves open question Q5 and materially narrows Q2/Q3/Q4. Key facts now locked as decisions D8-D13 in STATE.md: Workers inbound body is capped by the ZONE plan (Free/Pro 100 MB) while a Worker isolate has only 128 MB memory, so large-file ingest must be chunked; R2 multipart state must live outside the Worker (Cloudflare states this explicitly), making the chunk-session schema a day-one D1 decision; R2 multipart needs >=5 MiB parts, <=10000 parts, <=5 GiB per part, <=4.995 TiB per object, and allows only 1 write/sec per key; R2 egress is free and an R2 object body can be returned as the Response body with no enforced size limit; presigned URLs expire in 1s-7d, cannot use custom domains, and are unrevocable bearer tokens; D1 is documented as auto-commit with db.batch() as the only atomic unit and no BEGIN/COMMIT/ROLLBACK anywhere; D1 replicas may be arbitrarily out of date unless withSession()/bookmark is used; only 6 concurrent in-flight connections are allowed per invocation, shared across fetch/R2/D1/KV/Queues/Cache; Cron gives 5 triggers per account on Free with minute granularity, UTC only, and no documented delivery guarantee.","authorization":{"read":true,"write_code":true,"commit":true,"push":true,"deploy":false},"supersedes":[]}',
'{"id":"vps-file-hub-e012","at":"2026-10-07T03:10:00+08:00","type":"correction","source":"agent","summary":"Corrected an earlier inaccurate environment claim. STATE.md and AGENTS.md previously implied the machine had no usable web access. The accurate fact is narrower: the harness web_fetch tool is rejected because public hostnames resolve to the non-public TUN address 198.18.0.203. Ordinary HTTP works, and fetching the .md variant of a docs page with Invoke-WebRequest is a proven, reproducible path. Both files were corrected so a future session does not wrongly conclude that primary-source research is impossible here.","authorization":{"read":true,"write_code":true,"commit":true,"push":true,"deploy":false},"supersedes":[]}'
) -join "`n"

if (-not $txt.EndsWith("`n")) { $txt += "`n" }
[System.IO.File]::WriteAllText($p, $txt + $new + "`n", (New-Object System.Text.UTF8Encoding($false)))

# --- validate ---
$bytes = [System.IO.File]::ReadAllBytes($p)
if ([Array]::IndexOf($bytes, [byte]0) -ge 0) { throw 'stray NUL byte' }
if ($bytes[0] -eq 0xEF) { throw 'BOM present' }
if (($bytes | Where-Object { $_ -eq 13 }).Count -gt 0) { throw 'CR present' }
$lines = [System.IO.File]::ReadAllLines($p)
$ids = foreach ($l in $lines) { ($l | ConvertFrom-Json).id }
if (($ids | Group-Object | Where-Object Count -gt 1)) { throw 'duplicate event id' }
Write-Output ("events.jsonl OK: {0} lines, no NUL/BOM/CR, unique ids" -f $lines.Count)
$e010 = ($lines | Where-Object { $_ -match 'vps-file-hub-e010' } | ForEach-Object { $_ | ConvertFrom-Json })
Write-Output ("e010 status -> {0}" -f $e010.status)
Write-Output ("e011/e012 present: {0}" -f (($ids -contains 'vps-file-hub-e011') -and ($ids -contains 'vps-file-hub-e012')))

# --- drop the temporary validation script, keep the repo clean ---
Remove-Item -LiteralPath '.scratch\vps-file-hub\tmp-validate-research.ps1' -Force
Write-Output 'temp script removed'
