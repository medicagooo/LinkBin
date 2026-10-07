# Live-deployment smoke checks that do NOT claim the deployment and do NOT write to it.
#
# Every request here is either a read or a request the server must REFUSE. Nothing sets a password, adds a host,
# or starts a collection, so the deployment is left exactly as found and remains available for the operator to
# claim. This is the verification the goal asks for "against the live deployment where the ticket requires it",
# applied to the parts that can be checked before a password exists.
#
# WHY THIS EXISTS SEPARATELY FROM `pnpm test`. The offline suite runs against simulated D1 and R2 and CANNOT see
# platform limits the simulator does not enforce. That gap already produced one defect no test could catch:
# `PBKDF2_ITERATIONS` was 210,000 and the deployed runtime refuses anything above 100,000, so `/api/auth/setup`
# answered 500 on the real deployment while all 541 offline tests passed. Anything depending on the real runtime
# belongs here rather than in the suite.
#
# RUN IT AFTER A DEPLOY, NOT AFTER A PUSH. Workers Builds lags a push by several minutes; a run inside that window
# tests the PREVIOUS build and reports stale results as if they were current. That is exactly how the command
# below was once observed answering 500 after the fix had already been pushed and then 200 minutes later.
#
# WARNING, learned the hard way: an earlier version of section 6 sent a VALID 12-character password to probe the
# iteration ceiling. While that bug was live the request was refused, so it looked harmless — but the moment the
# fix deployed the same request SUCCEEDED and claimed the deployment with a throwaway password. A check must
# never be able to change the thing it is checking. Only passwords the server MUST refuse are sent.
$ErrorActionPreference = 'Continue'
$base = 'https://linkbin.cyc-xiaochen.workers.dev'
$failures = 0

# `[bool]$Ok` bound a bare `$false` unreliably: PowerShell coerced it to the empty string and then refused to
# convert that back to Boolean, so a FALSE result was reported as a failure TO EVALUATE. Three checks were
# reported as FAIL for a reason unrelated to what they asserted. The value is taken as an OBJECT and decided
# here instead, which has no coercion to get wrong.
function Check {
	param([string]$Name, $Ok, [string]$Detail = '')
	$pass = ($Ok -eq $true)
	# `[void]` because `$script:failures += 1` is an EXPRESSION and emits its new value into the pipeline. That
	# made this function return an array of two or three items instead of one line: `$line` became the first
	# element, and `-f`'s left operand was then an array, which threw and aborted the function BEFORE it printed
	# anything. The visible symptom was a silent "FAIL" with no detail — the true branch was never reached.
	# Assigning rather than incrementing, or discarding with [void], both fix it; the discard says why.
	if (-not $pass) { [void]($script:failures += 1) }
	$tag = if ($pass) { 'PASS' } else { 'FAIL' }
	('{0}  {1,-46} {2}' -f $tag, $Name, $Detail).TrimEnd()
}

function Hit {
	param([string]$Path, [string]$Method = 'GET', [hashtable]$Headers = @{}, [string]$Body = '')
	$params = @{ Uri = "$base$Path"; Method = $Method; TimeoutSec = 30; SkipHttpErrorCheck = $true }
	if ($Headers.Count) { $params.Headers = $Headers }
	if ($Body) { $params.Body = $Body }
	$r = Invoke-WebRequest @params
	return @{ Status = [int]$r.StatusCode; Body = $r.Content; Raw = $r }
}

Write-Output '=== 1. 部署可用性 ==='
$s = Hit '/api/status'
$st = $s.Body | ConvertFrom-Json
Check 'status reachable' ($s.Status -eq 200) "HTTP $($s.Status)"
Check 'schema ready' ($st.schema.ready -eq $true) "missing=$($st.schema.missing.Count)"
Check 'master key set' ($st.masterKeySet -eq $true) ''
Check 'R2 bound' ($st.r2Bound -eq $true) ''
Check 'host capacity stated' ($st.hosts.max -eq 50) "max=$($st.hosts.max)"
Check 'per-file limit stated' ($st.limits.maxFileBytes -eq 104857600) "$($st.limits.maxFileBytes)"

Write-Output ''
Write-Output '=== 2. 首次访问的认领状态（不做认领） ==='
$a = (Hit '/api/auth/state').Body | ConvertFrom-Json
Check 'reports not configured' ($a.configured -eq $false) "configured=$($a.configured)"
Check 'reports not signed in' ($a.signedIn -eq $false) "signedIn=$($a.signedIn)"
Check 'states the minimum length' ($a.minPasswordLength -ge 12) "min=$($a.minPasswordLength)"

Write-Output ''
Write-Output '=== 3. 未登录时，一切接触凭据或数据的东西都必须被拒 ==='
foreach ($p in @('/api/hosts', '/api/rules', '/api/usage', '/api/freshness', '/api/objects', '/api/shares', '/api/runs', '/api/merges', '/api/runs/detail?id=1')) {
	$r = Hit $p
	Check "GET $p refused" ($r.Status -eq 401) "HTTP $($r.Status)"
}

Write-Output ''
Write-Output '=== 4. 未登录时，写操作同样必须被拒 ==='
foreach ($p in @('/api/hosts/save', '/api/hosts/delete', '/api/collect', '/api/rules/save', '/api/shares/revoke', '/api/usage/reclaim', '/api/auth/password')) {
	$r = Hit $p 'POST' @{ 'content-type' = 'application/json' } '{}'
	# `/api/auth/password` answers 409 rather than 401 while no password is set: it refuses with "no password is
	# set yet" before authentication is reached. That is still a refusal and still correct, so the assertion is
	# "refused", not "401". The distinction is named rather than loosened silently.
	$expected = if ($p -eq '/api/auth/password') { '409 (no password set yet)' } else { '401' }
	$ok = if ($p -eq '/api/auth/password') { $r.Status -eq 409 } else { $r.Status -eq 401 }
	Check "POST $p refused" $ok "HTTP $($r.Status), expected $expected"
}

Write-Output ''
Write-Output '=== 5. 错误口令不能换到会话 ==='
$bad = Hit '/api/auth/login' 'POST' @{ 'content-type' = 'application/json' } '{"password":"definitely-not-the-password"}'
Check 'login with a wrong password refused' ($bad.Status -ge 400) "HTTP $($bad.Status)"
Check 'and issues no session cookie' ($null -eq $bad.Raw.Headers['Set-Cookie']) 'no Set-Cookie'

Write-Output ''
Write-Output '=== 6. 不合规的口令在设置阶段就被拒（不是先存后拒） ==='
# ONLY passwords the server must refuse are sent. An earlier version of this script included a VALID
# 12-character password to probe the iteration ceiling; once the ceiling fix deployed, that same request
# SUCCEEDED and claimed the deployment. A check must never be able to change the thing it is checking.
foreach ($pw in @('short', 'elevenchars', "aaaaaaaaaaa$([char]0)")) {
	$body = @{ password = $pw } | ConvertTo-Json -Compress
	$r = Hit '/api/auth/setup' 'POST' @{ 'content-type' = 'application/json' } $body
	Check ("setup refuses {0}" -f ($pw -replace [char]0, '<NUL>')) ($r.Status -ge 400) "HTTP $($r.Status)"
	# THE ENTIRE COMPARISON IS PARENTHESISED. An earlier version read
	#     Check 'name' ((Hit ...).Body | ConvertFrom-Json).configured -eq $false
	# which is not the comparison at all: `-eq` and `$false` land OUTSIDE the parentheses and bind to Check's own
	# parameters, so the function receives a truthy object as `$Ok` while `$Detail` is never touched. The
	# assertion then reports FAIL regardless of the fact being checked, and reads as a deployment fault rather
	# than a script fault. PowerShell accepted it silently, which is why it survived several runs.
	Check '  and claims nothing' (((Hit '/api/auth/state').Body | ConvertFrom-Json).configured -eq $false)
}

Write-Output ''
Write-Output '=== 7. 不存在的分享令牌与死链不可区分 ==='
$u = Hit '/s/not-a-real-token'
$d = ($u.Body | ConvertFrom-Json)
Check 'unknown share token 404' ($u.Status -eq 404) "HTTP $($u.Status)"
Check 'and says only that it is invalid' ($d.reason -eq 'unknown') "reason=$($d.reason)"

Write-Output ''
Write-Output '=== 8. 没有堆栈泄漏给匿名调用者 ==='
$leak = $false
foreach ($p in @('/api/hosts', '/s/x', '/api/objects')) {
	$b = (Hit $p).Body
	if ($b -match 'at Object\.|at async |\.ts:\d+|SQLITE_ERROR|stack') { $leak = $true; Write-Output "   leaked in $p" }
}
Check 'no stack traces in anonymous responses' (-not $leak) ''

Write-Output ''
if ($failures -eq 0) { Write-Output 'ALL LIVE CHECKS PASSED' } else { Write-Output "$failures LIVE CHECK(S) FAILED" }
exit $failures
