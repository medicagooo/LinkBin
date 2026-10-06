$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'D:\proj\LinkBin'
$p = (Resolve-Path -LiteralPath '.branch-records\vps-file-hub\events.jsonl').Path

$ev = '{"id":"vps-file-hub-e013","at":"2026-10-07T03:20:00+08:00","type":"correction","source":"agent","summary":"Process incident, self-reported: a throwaway helper script (.scratch/vps-file-hub/tmp-record.ps1) was swept into commit 4ab3a17 by a broad git add -A and pushed to main without a predeclared operation event, because the commit that carried the research note also staged an unrelated temp file. Impact: one disposable 5 KB script is present in the public main history at 4ab3a17, which is not a secret leak (the only credential-keyword match is the technical term bearer tokens) but does violate the predeclaration discipline and adds an unintended file to a public repository. Correction: the file is removed in the following commit. Chosen remedy is a normal follow-up commit rather than a force-push rewrite of main, because rewriting already-published main history is a force operation that the current authorization does not cover and would break the default branch for anyone who has fetched it. Recorded so the residue in history is not mistaken for intentional content later.","authorization":{"read":true,"write_code":true,"commit":true,"push":true,"deploy":false},"supersedes":[]}'

$txt = [System.IO.File]::ReadAllText($p)
if (-not $txt.EndsWith("`n")) { $txt += "`n" }
[System.IO.File]::WriteAllText($p, $txt + $ev + "`n", (New-Object System.Text.UTF8Encoding($false)))

# validate
$bytes = [System.IO.File]::ReadAllBytes($p)
if ([Array]::IndexOf($bytes, [byte]0) -ge 0) { throw 'NUL' }
if ($bytes[0] -eq 0xEF) { throw 'BOM' }
if (($bytes | Where-Object { $_ -eq 13 }).Count -gt 0) { throw 'CR' }
$lines = [System.IO.File]::ReadAllLines($p)
$ids = foreach ($l in $lines) { ($l | ConvertFrom-Json).id }
if (($ids | Group-Object | Where-Object Count -gt 1)) { throw 'dup id' }
Write-Output ("events.jsonl OK: {0} events, unique ids" -f $lines.Count)

# remove the stray file
git rm -q --cached '.scratch/vps-file-hub/tmp-record.ps1' | Out-Null
Remove-Item -LiteralPath '.scratch\vps-file-hub\tmp-record.ps1' -Force
git add -A

$msg = @'
chore: remove an accidental temp script from the repo

tmp-record.ps1 was a throwaway helper swept into 4ab3a17 by a broad
git add -A. It is not a secret, but it should not be in this public repo.
Removed here rather than by rewriting published main history, since a
force-push is outside the current authorization.

Refs: .branch-records/vps-file-hub/events.jsonl (e013)
'@
$msg | git commit -q -F -
if ($LASTEXITCODE -ne 0) { throw "commit failed ($LASTEXITCODE)" }

Write-Output '=== push ==='
git push origin main 2>&1 | ForEach-Object { $_ }
if ($LASTEXITCODE -ne 0) { throw "push failed ($LASTEXITCODE)" }

Write-Output '=== final state ==='
git log --oneline
"local  main: $(git rev-parse main)"
"origin/main: $(git rev-parse origin/main)"
Write-Output '--- tracked files ---'
git ls-files
Write-Output '--- working tree ---'
$d = git status --porcelain
if ($d) { $d } else { '(clean)' }
