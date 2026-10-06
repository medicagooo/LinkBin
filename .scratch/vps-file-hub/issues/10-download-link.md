# 10: Download — a link on the operator's own domain, with an optional password

**What to build:** The operator takes a stored file, gets a link that works from their own domain, and
hands it out. The link stops working after a couple of hours, can be cancelled sooner if it goes to
the wrong place, and can be protected so that the link alone is not enough.

The link is issued by the Worker rather than by storage directly, for two reasons that are
requirements rather than preferences: storage-issued links cannot be used with a custom domain at all,
and they cannot be revoked. A link that cannot be cancelled is a permanent exposure the moment it is
misdirected, and the password check has to happen where the file is served, or it is not a check.

**Blocked by:** 02, 05.

**Status:** ready-for-agent

- [ ] The operator can obtain a download link for a stored file from the interface.
- [ ] The link works from a custom domain rather than a raw storage hostname.
- [ ] The link stops working after its validity window, and an expired link says so distinctly rather than looking like a server fault.
- [ ] A link can be revoked before it expires, and a revoked link is refused distinctly from an expired one.
- [ ] A file can be protected with a password, and a download without it, or with a wrong one, is refused completely rather than partially served.
- [ ] The password is checked where the file is served, so that reaching storage by another route does not bypass it.
- [ ] The file is streamed to the consumer rather than loaded into the Worker's memory, so that a large file can be downloaded.
- [ ] The size of the file is shown before the download starts.
- [ ] A link grants access to exactly one file and cannot be edited into granting another.
- [ ] Issuing a link requires an authenticated operator; consuming one does not.
- [ ] Tests cover: valid link, expired link, revoked link, correct password, wrong password, missing password, and a link for one file used against another.
