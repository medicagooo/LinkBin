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

**Status:** ready-for-agent

- [ ] On a deployment with no password set, the first visit offers to set one, and no other action is possible until it is set.
- [ ] Once a password is set, the setup path is closed: it cannot be used to overwrite an existing password, not even by visiting it again.
- [ ] Every existing interface and API route refuses an unauthenticated request, and the refusal says what to do rather than leaking whether a resource exists.
- [ ] The operator can sign in with the password and then use the interface without re-entering it for a reasonable working session.
- [ ] The session expires, and an expired session is refused distinctly from a wrong password.
- [ ] Signing out ends the session immediately, and the ending is enforced by the server rather than only by the interface forgetting.
- [ ] A signed-in session survives a page reload.
- [ ] The password is never stored in a form that can be read back: only a salted, deliberately slow hash is kept, so a database leak does not hand over the interface.
- [ ] Changing the password requires the current one and **ends every existing session**, so that changing it actually locks out anything already signed in.
- [ ] An empty, whitespace-only, or trivially short password is refused with an explanation.
- [ ] Repeated wrong attempts are slowed or limited, so the single secret standing between the internet and the stored credentials cannot be ground down by brute force.
- [ ] Collection can be triggered non-interactively by the scheduler with a credential that is not an interactive session.
- [ ] **No new deployment secret is introduced.** Sessions and the non-interactive credential derive from the existing master key, so the single-secret architecture is preserved; adding a second secret would be a change to that decision, not an implementation detail.
- [ ] The interactive session and the non-interactive trigger credential are distinguishable, so revoking one does not disable the other.
- [ ] Tests cover: first visit with no password, a second attempt to use the setup path, wrong password, expired session, valid session, password change ending sessions, a too-short password, and the non-interactive trigger.
