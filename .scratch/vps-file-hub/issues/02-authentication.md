# 02: Authentication for the interface and API

**What to build:** A stranger who finds the deployed address can do nothing. The operator signs in
once and then uses the interface normally, and the scheduler can trigger a collection without a
human present.

This is first because everything after it stores real credentials and real files in a Worker that is
already publicly reachable, and because an unauthenticated interface plus a stored credential plus an
endpoint that acts on it is precisely the combination that turned an earlier diagnostic route into a
live exposure.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] Every existing interface and API route refuses an unauthenticated request, and the refusal says what to do rather than leaking whether a resource exists.
- [ ] The operator can sign in from the interface and then use it without re-entering anything for a reasonable working session.
- [ ] The session expires, and an expired session is refused distinctly from a wrong credential.
- [ ] Signing out ends the session immediately, and the ending is enforced by the server rather than only by the interface forgetting.
- [ ] A signed-in session survives a page reload.
- [ ] Collection can be triggered non-interactively by the scheduler with a credential that is not an interactive session.
- [ ] **No new deployment secret is introduced.** The authentication material derives from the existing master key, so the single-secret architecture is preserved; adding a second secret would be a change to that decision, not an implementation detail.
- [ ] The interactive and non-interactive credentials are distinguishable, so revoking one does not disable the other.
- [ ] Tests cover: no credential, wrong credential, expired session, valid session, and non-interactive trigger.
