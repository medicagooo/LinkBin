# 02: Authentication — first-visit password, for a single-operator tool

**What to build:** A stranger who finds the deployed address can do nothing. On the very first visit
the operator sets a password; from then on that password signs them in. The scheduler can still
trigger a collection without a human present.

This is first because everything after it stores real credentials and real files in a Worker that is
already publicly reachable, and because an unauthenticated interface plus a stored credential plus an
endpoint that acts on it is precisely the combination that turned an earlier diagnostic route into a
live exposure.

This is a single-operator tool, so there is no user system, no roles and no invitations. The password
is set by whoever arrives first and can only be changed by someone already signed in.

**Blocked by:** 01.

**Status:** resolved

**Committed in** `54c227c`, with the scheduler credential completed afterwards. 47 tests pass offline.

**Still required in production, and not done by the commit** — deploying uploads code only and does not
run migrations (D47), so two actions remain and they need the operator: apply the schema, then set the
initial password. Until the password is set, the deployment accepts a first visitor capable of claiming
it, which is why this is urgent rather than routine.

- [x] On a deployment with no password set, the first visit offers to set one, and no other action is possible until it is set.
- [x] Once a password is set, the setup path is closed: it cannot be used to overwrite an existing password, not even by visiting it again. Enforced by the stored row existing, not by a resettable flag.
- [x] Every existing interface and API route refuses an unauthenticated request, and the refusal says what to do rather than leaking whether a resource exists — an unknown route and a protected one give an identical response.
- [x] The operator can sign in with the password and then use the interface without re-entering it for a reasonable working session.
- [x] The session expires, and an expired session is refused distinctly from a wrong password.
- [x] Signing out ends the session immediately, and the ending is enforced by the server rather than only by the interface forgetting.
- [x] A signed-in session survives a page reload.
- [x] The password is never stored in a form that can be read back: only a salted, deliberately slow hash is kept, so a database leak does not hand over the interface.
- [x] Changing the password requires the current one and **ends every existing session**, so that changing it actually locks out anything already signed in.
- [x] An empty, whitespace-only, or trivially short password is refused with an explanation.
- [x] Repeated wrong attempts are slowed or limited, so the single secret standing between the internet and the stored credentials cannot be ground down by brute force. Scoped **per caller**, so an attacker cannot lock the operator out.
- [x] Collection can be triggered non-interactively by the scheduler with a credential that is not an interactive session.
- [x] **No new deployment secret is introduced.** Sessions and the scheduler credential both derive from the existing master key, so the single-secret architecture is preserved.
- [x] The interactive session and the non-interactive trigger credential are distinguishable, so revoking one does not disable the other — tested in both directions: a session is refused where the scheduler credential is expected, and the scheduler credential is refused on the management API.
- [x] Tests cover: first visit with no password, a second attempt to use the setup path, wrong password, expired session, valid session, password change ending sessions, a too-short password, and the non-interactive trigger.

## Comments

Two real bugs were found by these tests rather than by reading the code.

**The brute-force counter was global.** One attacker failing repeatedly could have locked the operator
out of their own deployment — a protection turned into a denial of service against the only account.
It is now scoped to the caller.

**Sessions invalidated themselves.** Issued-at was recorded in whole seconds and the floor set by a
sign-out or password change was also in seconds, so a token minted in the same second as the floor
compared as "not newer" and was refused. The diagnostics showed `issuedAt` exactly equal to the floor.
The fix was millisecond precision on both sides rather than a tolerance, so revocation stays strict:
a token minted in the same millisecond as a revocation is still refused.

**A deliberate exception worth knowing about.** `/api/admin/apply-schema` and `/api/status` are
reachable without signing in. A fresh deployment has no tables and therefore nowhere to store a
password, so the bootstrap must precede the lock. Neither exposes a credential: one creates only
tables and indexes, the other reports whether a password exists and which tables are present. If the
schema bootstrap is ever extended to read or write data, it must move behind the session check.
