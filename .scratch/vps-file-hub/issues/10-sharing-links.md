# 10: Sharing — a link on the operator's own domain, with a chosen lifetime and an optional password

**What to build:** The operator picks a stored file, chooses how long the share should last and
optionally a password, and gets a link. The recipient opens the link, enters the password if there is
one, and downloads the file. The operator can see the shares they have issued and cancel one.

The link is issued by the Worker rather than by storage directly, for two reasons that are
requirements rather than preferences: storage-issued links cannot be used with a custom domain at all,
and they cannot be revoked. A link that cannot be cancelled is a permanent exposure the moment it is
misdirected, and the password check has to happen where the file is served, or it is not a check.

**Blocked by:** 02, 05.

**Status:** 15 of 15 met and tested offline, including by an adversarial audit that tried to bypass the password, reach another file through a share, revive an expired link and spoof the host. Nothing here needs a machine. The one thing NOT verified is a real custom domain, which is a deployment step (binding the domain in the dashboard) rather than code.

- [x] The operator chooses a specific stored file to share, and the link grants access to that file and nothing else. `POST /api/shares` takes an object id and the token resolves to exactly one row; `WHERE s.token = ?` is parameterised and no request value reaches the object choice. Twelve parameter, header and path manipulations were tried against this by an adversarial audit and none returned another object's bytes.
- [x] The operator sets the share's lifetime when creating it, defaulting to two hours. `DEFAULT_SHARE_SECONDS = 7200` and the interface offers 15 minutes through 24 hours.
- [x] The link works from a custom domain. The URL is built from the request's own origin — `new URL(request.url).origin` — so binding a domain makes every link use it, and a raw storage hostname never appears.
- [x] The link stops working once its lifetime has passed, and says so distinctly: `describeShare` checks revoked, then expired, then password, and expiry is inclusive of its own instant. An expired link answers 410 with its own message rather than looking like a fault.
- [x] The operator can cancel a share before it expires, and a cancelled link is refused distinctly from an expired one: `revoked_at` is a separate column from `expires_at` precisely so the two can be told apart. Cancelling is idempotent — a second revoke answers 404.
- [x] The operator can set a password on a share, and a recipient without it or with the wrong one is refused completely — no bytes, no source path, no content hash. Fourteen non-passwords were tried against this by an adversarial audit. The minimum is eight characters, raised from four because this route had no throttling at the time.
- [x] The password is checked where the file is served. `serveShare` resolves the object only after `describeShare` says the share is usable, so the storage key is never reached without it; there is no separate path to the bytes that skips the check.
- [x] A recipient with the link and the password can download with no account and no other access. `/s/<token>` is deliberately reachable without a session — the one place an unauthenticated request can obtain bytes — and what bounds it is that a token grants exactly one file.
- [x] The password itself is not stored recoverably: PBKDF2 with a per-share salt, so a database leak does not hand over every live share at once. The generated token is random rather than derived, so nothing about it can be computed from the database either.
- [x] The operator can list the shares they have issued, with what each one points at and when it dies — the shares panel shows the path, the size, the remaining lifetime, whether it is protected, and its download count. The list is bounded at 200, which an adversarial audit found was not true before.
- [x] The file is streamed to the recipient rather than loaded into the Worker's memory: `new Response(object.body, …)` passes the stored stream straight through, because the per-file limit is far larger than this runtime's memory and buffering would defeat the entire streaming pipeline that stored it.
- [x] The file's size is shown before the download starts: `publicShareView` returns `sizeBytes` with the password prompt, along with the file name, the expiry and whether a password is needed.
- [x] A share's lifetime cannot be set beyond a stated maximum. `MAX_SHARE_SECONDS = 86400`, and `shareLifetimeProblem` refuses anything above it rather than clamping, so "short-lived" stays true even by accident.
- [x] Issuing or cancelling a share requires an authenticated operator; consuming one does not. Both management routes sit behind the session guard, and the audit confirmed anonymous create and cancel are 401 while the share survives.
- [x] Tests cover all eight cases — valid, expired, cancelled, correct password, wrong password, missing password, a share used against a different file, and a lifetime beyond the maximum — plus the adversarial audit file that proves the cross-file attempts fail.
