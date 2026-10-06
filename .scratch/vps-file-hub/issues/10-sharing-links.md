# 10: Sharing — a link on the operator's own domain, with a chosen lifetime and an optional password

**What to build:** The operator picks a stored file, chooses how long the share should last and
optionally a password, and gets a link. The recipient opens the link, enters the password if there is
one, and downloads the file. The operator can see the shares they have issued and cancel one.

The link is issued by the Worker rather than by storage directly, for two reasons that are
requirements rather than preferences: storage-issued links cannot be used with a custom domain at all,
and they cannot be revoked. A link that cannot be cancelled is a permanent exposure the moment it is
misdirected, and the password check has to happen where the file is served, or it is not a check.

**Blocked by:** 02, 05.

**Status:** ready-for-agent

- [ ] The operator chooses a specific stored file to share, and the resulting link grants access to that file and to nothing else.
- [ ] The operator sets the share's lifetime when creating it, with the default being a couple of hours rather than a fixed unchangeable value.
- [ ] The link works from a custom domain rather than a raw storage hostname.
- [ ] The link stops working once its lifetime has passed, and an expired link says it expired rather than looking like a server fault.
- [ ] The operator can cancel a share before it expires, and a cancelled link is refused distinctly from an expired one.
- [ ] The operator can set a password on a share, and a recipient without it, or with a wrong one, is refused completely rather than partially served.
- [ ] The password is checked where the file is served, so that reaching storage by another route does not bypass it.
- [ ] A recipient with the link and the password can download with no account and no other access.
- [ ] The password itself is not stored recoverably, so a database leak does not hand over every live share at once.
- [ ] The operator can list the shares they have issued, with what each one points at and when it dies.
- [ ] The file is streamed to the recipient rather than loaded into the Worker's memory, so that a large file can be downloaded.
- [ ] The file's size is shown before the download starts.
- [ ] A share's lifetime cannot be set beyond a stated maximum, so that "short-lived" stays true even by accident.
- [ ] Issuing or cancelling a share requires an authenticated operator; consuming one does not.
- [ ] Tests cover: valid share, expired share, cancelled share, correct password, wrong password, missing password, a share used against a different file, and a lifetime beyond the maximum.
