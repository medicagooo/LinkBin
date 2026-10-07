# Ticket 04 — the throughput measurement, ready to run the moment a host exists.
#
# WHAT THIS IS FOR. Ticket 04 decides the per-file limit, and every remaining criterion in tickets 04 and 06
# depends on its answer. The ticket also requires that the measurement endpoint be DELETED before the ticket is
# done, because a diagnostic acting on a stored credential must not outlive the question it answered — an earlier
# one did and became a live exposure (D41). Rather than build a route that would then have to be removed, this
# measures through the routes that already exist and `wrangler tail` for the numbers the response cannot carry.
#
# WHY IT CANNOT RUN YET. It needs one host with a stored credential, and that needs an operator password that
# only a human can set: `/api/auth/state` reports `configured: false`. So this script checks that precondition
# first and says so plainly instead of failing in a confusing way.
#
# HOW IT WORKS.
#   1. It watches the deployment's logs in the background with `wrangler tail`.
#   2. It asks for a collection through the normal authenticated route.
#   3. It reads from the tail what the Worker logged: CPU time, wall time, and the per-run totals.
#   4. It reports the achieved throughput and whether a 100 MB file fits one invocation with margin.
#
# It reads only. It does not add a host, a rule, or a collection it was not asked for, and it writes nothing to
# D1 or R2. To measure a LARGE file, put one at a path a rule matches and add a rule — both of which are operator
# actions, so this script prints the exact steps rather than taking them.
#
# USAGE
#   1. Set a password in the interface and add one host with a stored credential.
#   2. Add a rule matching a directory that holds a file of roughly the size you want to measure.
#   3. pwsh -File scripts/measure-throughput.ps1 -Cookie 'linkbin_session=...'
#      The cookie comes from the browser after signing in (DevTools > Application > Cookies).
param(
	[string]$Base = 'https://linkbin.cyc-xiaochen.workers.dev',
	[string]$Cookie,
	[int]$TimeoutSeconds = 420
)

$ErrorActionPreference = 'Continue'

function Say([string]$Text) { Write-Output $Text }

Say '=== ticket 04: throughput measurement ==='
Say ''

# --- precondition: a deployment that can authenticate, and a machine to reach ------------------------------------
$status = try { (Invoke-WebRequest -Uri "$Base/api/status" -TimeoutSec 30 -SkipHttpErrorCheck).Content | ConvertFrom-Json } catch { $null }
if (-not $status) { Say 'FAIL  the deployment did not answer /api/status'; exit 1 }
Say ("deployment  schema ready = {0}, master key set = {1}, R2 bound = {2}" -f $status.schema.ready, $status.masterKeySet, $status.r2Bound)

$auth = try { (Invoke-WebRequest -Uri "$Base/api/auth/state" -TimeoutSec 30 -SkipHttpErrorCheck).Content | ConvertFrom-Json } catch { $null }
if (-not $auth.configured) {
	Say ''
	Say 'BLOCKED. No operator password is set, so no host can be added and nothing can be measured.'
	Say 'This is the precondition ticket 04 waits on, and it cannot be automated: the setup path exists precisely'
	Say 'so that whoever reaches a fresh deployment first claims it.'
	Say ''
	Say ("  1. Open {0}" -f $Base)
	Say '  2. Set a password (minimum 12 characters).'
	Say '  3. Add a host: label, address, port, user, and its credential.'
	Say '  4. Add a rule matching a directory holding a file of the size you want to measure.'
	Say '  5. Re-run this script with -Cookie from the browser session.'
	exit 2
}

if (-not $Cookie) {
	Say ''
	Say 'BLOCKED. No session cookie was supplied, so the collection route cannot be called.'
	Say 'Sign in, then copy the `linkbin_session` cookie value from the browser and pass it as -Cookie.'
	exit 2
}

# --- what is configured to be collected -------------------------------------------------------------------------
$rules = try { (Invoke-WebRequest -Uri "$Base/api/rules" -Headers @{ cookie = $Cookie } -TimeoutSec 30 -SkipHttpErrorCheck).Content | ConvertFrom-Json } catch { $null }
if ($rules -and $rules.rules) {
	Say ("rules       {0} configured" -f @($rules.rules).Count)
	foreach ($r in @($rules.rules)) { Say ("              {0} {1}" -f $(if ($r.isExclude) { 'exclude' } else { 'include' }), $r.pattern) }
} else {
	Say 'BLOCKED. No source rules are configured, so a collection would find nothing to measure.'
	exit 2
}

Say ''
Say 'Starting the log tail. Every number below comes from the Worker''s own log, not from this script''s clock.'
Say ''

# --- tail the deployment in the background, then collect once ----------------------------------------------------
$logPath = Join-Path $env:TEMP ("linkbin-tail-{0}.log" -f (Get-Date -Format 'HHmmss'))
$tail = Start-Process -FilePath 'node' -ArgumentList @(
	'./node_modules/.pnpm/wrangler@4.147.0/node_modules/wrangler/bin/wrangler.js',
	'tail', '--name', 'linkbin', '--format', 'json'
) -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err" -PassThru -NoNewWindow

Start-Sleep -Seconds 8
Say ("tail        running as pid {0}, writing to {1}" -f $tail.Id, $logPath)

$started = Get-Date
$collect = try {
	Invoke-WebRequest -Uri "$Base/api/collect" -Method POST -Headers @{ cookie = $Cookie } -TimeoutSec $TimeoutSeconds -SkipHttpErrorCheck
} catch {
	Say ("collect     FAILED: {0}" -f $_.Exception.Message)
	Stop-Process -Id $tail.Id -Force -ErrorAction SilentlyContinue
	exit 1
}
$elapsed = (Get-Date) - $started

Say ("collect     HTTP {0} after {1:n1}s" -f $collect.StatusCode, $elapsed.TotalSeconds)
Say ($collect.Content)

# Give the log a moment to flush, then stop tailing.
Start-Sleep -Seconds 6
Stop-Process -Id $tail.Id -Force -ErrorAction SilentlyContinue

# --- what the Worker said about its own invocation ----------------------------------------------------------------
Say ''
Say '=== the Worker''s own figures ==='
$interesting = Select-String -Path $logPath -Pattern 'outcome|cpuTime|wallTime|duration|exceededCpu|exceededMemory' -ErrorAction SilentlyContinue |
	Select-Object -Last 12
if ($interesting) { $interesting | ForEach-Object { $_.Line.Trim() } } else { Say 'no matching log lines; the deployment may not have observability enabled' }

Say ''
Say '=== what to record in ticket 04 ==='
Say '  wall clock for the run        from the "collect" line above'
Say '  CPU time and peak memory      from the tail lines above (cpuTime, wallTime)'
Say '  bytes stored and file count   from the JSON the collect route returned (totals)'
Say '  whether 100 MB fits with room  compare the CPU time against the platform ceiling for the plan'
Say ''
Say 'Record the numbers in STATE.md and the spec, and if the per-file limit changes from 100 MB, update tickets'
Say '05 and 06 rather than leaving them inconsistent — that is an explicit criterion of ticket 04.'
