{
  "schema": "branch-registry/1",
  "repo": "LinkBin",
  "root": "D:\\proj\\LinkBin",
  "format": ".branch-records/FORMAT.md",
  "timezone": "+08:00",
  "records": [
    {
      "task": "vps-file-hub",
      "state": ".branch-records/vps-file-hub/state.json",
      "events": ".branch-records/vps-file-hub/events.jsonl",
      "purpose": "Collect designated files from multiple VPS hosts into Cloudflare R2 + D1 and let other devices download them",
      "status": "active",
      "integration": "unmerged"
    },
    {
      "task": "ssh-probe",
      "state": ".branch-records/ssh-probe/state.json",
      "events": ".branch-records/ssh-probe/events.jsonl",
      "purpose": "Prototype answering one question: can a Cloudflare Worker connect to a real VPS over SSH and read a file? Answers whether the chosen collection channel is viable at all.",
      "status": "active",
      "integration": "unmerged",
      "branch": "prototype/ssh-probe",
      "merge_policy": "originally never merged; merged to main on 2026-10-07 (event e019) because Workers Builds deploys from the connected repository. The probe routes ship inside the main Worker and are disposable."
    },
    {
      "task": "1008-review-bug-repair",
      "state": ".branch-records/1008-review-bug-repair/state.json",
      "events": ".branch-records/1008-review-bug-repair/events.jsonl",
      "purpose": "Review the complete current implementation, repair reproducible bugs, validate offline and push verified repairs to origin/main",
      "status": "active",
      "integration": "unmerged"
    },
    {
      "task": "1008-r2-file-manager",
      "state": ".branch-records/1008-r2-file-manager/state.json",
      "events": ".branch-records/1008-r2-file-manager/events.jsonl",
      "purpose": "TypeScript target-profile processing and R2 file management with direct/password links",
      "status": "active",
      "integration": "unmerged"
    }
  ],
  "active": [
    "vps-file-hub",
    "ssh-probe",
    "1008-review-bug-repair",
    "1008-r2-file-manager"
  ],
  "pending": [
    "vps-file-hub-e038: push main to origin to deploy the UI authentication fix (predeclared; awaiting execution)"
  ],
  "remote": {
    "origin": "git@github.com:medicagooo/LinkBin.git",
    "url": "https://github.com/medicagooo/LinkBin",
    "visibility": "PUBLIC",
    "default_branch": "main",
    "last_verified_main": "ef44b77bc7db41c094369d780e0eae213399fcc5",
    "verified_at": "2026-10-08T02:45:24.0498328+08:00"
  },
  "read": [],
  "changes": [
    {
      "id": "C-001",
      "requirement_date": "2026-10-07",
      "implementation_date": "2026-10-07",
      "deployment_date": "2026-10-07",
      "domain": "deployment / management surface",
      "request": "vps-file-hub-e023",
      "evidence": [
        "vps-file-hub-e024",
        ".scratch/vps-file-hub/STATE.md"
      ],
      "before": "LinkBin existed only as source. The account held no linkbin Worker, D1 database or R2 bucket, so nothing was reachable and the SSH channel could not be exercised at all.",
      "after": "Worker \"linkbin\" is live at https://linkbin.cyc-xiaochen.workers.dev with D1 database linkbin-db, R2 bucket linkbin-files and the SSH_MASTER_KEY secret. The schema is applied (hosts, source_rules, objects, multipart_sessions), so hosts plus credentials and collection rules can be managed at runtime through the web UI without a redeploy.",
      "rules": "R2 bucket_name is pinned in wrangler.jsonc; database_name is pinned but database_id is deliberately absent, so the repository carries no account-specific resource ID. SSH_MASTER_KEY is write-once: replacing it makes every stored credential undecryptable.",
      "side_effects": "The UI and the /probe routes have NO authentication (D35). Anyone reaching the Worker can manage hosts and credentials; the /probe routes reach a stored host. Accepted by the user as a private-tool risk.",
      "status": "deployed; feature incomplete (store-verified collection and download are not built)"
    },
    {
      "id": "C-002",
      "requirement_date": "2026-10-07",
      "implementation_date": "2026-10-07",
      "deployment_date": "2026-10-07",
      "domain": "security / deployed data",
      "request": "vps-file-hub-e023",
      "evidence": [
        "vps-file-hub-e025",
        ".scratch/vps-file-hub/STATE.md"
      ],
      "before": "The live deployment stored one enabled host with a real root password for a remote machine, plus a collection rule and three objects in R2. Because the UI and the /probe routes have no authentication, and the probe falls back to the first stored host with a credential, any internet user could have called GET /probe/read?path=<anything> to read arbitrary files from that machine as root and write them into R2. The exposure was current, not theoretical.",
      "after": "No host and no credential is stored in the deployment: hosts and source_rules are empty and the three probe objects are deleted. The unauthenticated probe path no longer has a target.",
      "rules": "The /probe* routes are still unauthenticated. They are only harmless while no host row exists, so adding a host re-creates the exposure until D35 (authentication) is implemented.",
      "side_effects": "The encrypted password was destroyed with its row and is unrecoverable. D30 already recommended rotating that host's root password because it had entered the session record.",
      "status": "done; underlying D35 authentication gap remains open"
    },
    {
      "id": "C-003",
      "requirement_date": "2026-10-07",
      "implementation_date": "2026-10-07",
      "domain": "host management UI / authentication",
      "request": "user instruction on 2026-10-07: let the host form choose between two authentication methods, and repair the reported bug that saving a host appeared to do nothing",
      "evidence": [
        "src/ui.ts",
        "scripts/check-ui-template.mjs",
        ".scratch/vps-file-hub/STATE.md D48 and D49"
      ],
      "before": "The form showed password, key passphrase and private key as three independent optional fields, leaving the operator to infer the combination the server wanted. Saving reported only through the result panel further down the page, and not one request on the page had a .catch(), so a dropped connection or a redeploy in flight made a click do literally nothing with no message anywhere. There was no client-side validation either, so an empty address was answered by the server, again only in that distant panel.",
      "after": "Authentication is an explicit choice - username with password, or username with private key and optional passphrase - and only the chosen method is displayed and submitted. Username stays visible in both because SSH requires one. Saving validates locally, disables the button while in flight, and reports success or the server's exact error immediately beneath the button. Every request is bounded at 30 seconds and normalises rejection, timeout and HTTP failure into one shape, so no call can fail invisibly.",
      "rules": "An empty credential field still means keep what is already stored, which is what allows a host to be edited without re-entering its credential. A key-mode save no longer sends an empty password and vice versa, so a host never accumulates an unused second credential.",
      "side_effects": "The form no longer closes after a successful save, because closing it would hide the confirmation that was just added. The UI template guard gained an absolute rule against backticks in the script body after a backtick in a comment shipped a page that failed only at runtime.",
      "status": "done; code complete and verified locally against wrangler dev, not yet deployed"
    },
    {
      "main_integration_date": "2026-10-08",
      "rules": "No multi-statement atomicity, new migration or secret. Capacity includes retained and orphan bytes. Derived source identities remain protected. Predecessor is protected during replacement admission; replacement may need temporary room for both versions.",
      "request": "1008-review-bug-repair-e001",
      "before": "Size estimates and incomplete metadata accounting could exceed capacity; concurrent writes could race. Replacement reused keys, could destroy a prior version or lose importance, and stale shares could read replacement bytes. Host deletion left bytes behind.",
      "requirement_date": "2026-10-08",
      "after": "Actual streams obey 100 MiB per file and 10 GiB total, inventory includes orphan bytes and all metadata pages, and admissions reclaim oldest unprotected objects. A renewing D1 writer lease serializes mutations. Unique version keys and durable publication recovery preserve the predecessor and protection on failure; retired shares return 410. Host deletion removes owned bytes before metadata.",
      "deployment_date": null,
      "status": "implemented, verified offline and integrated/pushed at ef44b77; live deployment not verified",
      "evidence": [
        "src/storage.ts: storageObjects, withStorageWriter, publishVersion, recoverPublications",
        "src/collect-store.ts: collectionPorts",
        "src/store.ts: storeStream",
        "test/review-regressions.test.ts",
        "1008-review-bug-repair-e003"
      ],
      "id": "C-004",
      "implementation_date": "2026-10-08",
      "domain": "storage / retention / downloads"
    },
    {
      "main_integration_date": "2026-10-08",
      "rules": "Preview remains bounded separately. 50-host count excludes the internal derived host. No VPS agent or probe routes added; unchanged files still transfer for hash comparison.",
      "request": "1008-review-bug-repair-e001",
      "before": "An old stopped cursor could revive after a finished run; a timed-out file advanced the cursor and disappeared. More than 2,000 resolved paths and directory wildcards could be skipped; unresolved exclusion rules could allow collection.",
      "requirement_date": "2026-10-08",
      "after": "Resume uses the selected host latest run, a completed run invalidates earlier cursors, and an incomplete file remains next. Collection resolves the complete path set then stops explicitly at its per-run walk bound. Directory wildcards expand to concrete paths; unresolved exclusions stop collection.",
      "deployment_date": null,
      "status": "implemented, verified offline and integrated/pushed at ef44b77; live deployment not verified",
      "evidence": [
        "src/index.ts: collection route",
        "src/collect.ts: collectFrom",
        "src/remote.ts: resolveRules",
        "test/review-regressions.test.ts",
        "1008-review-bug-repair-e003"
      ],
      "id": "C-005",
      "implementation_date": "2026-10-08",
      "domain": "collection / rules / resume"
    },
    {
      "main_integration_date": "2026-10-08",
      "rules": "At most 8 MiB aggregate text input is materialized; larger selections are refused with the old output preserved. Live outputs protect their source host/path identities across replacement. Scheduled credentials do not grant management authority.",
      "request": "1008-review-bug-repair-e001",
      "before": "Derived outputs did not refresh after successful source collection; broad derived exclusion prevented chains while wildcard/absolute-path cycles escaped definition checks. Aggregate source reads could exhaust memory and writes bypassed shared admission.",
      "requirement_date": "2026-10-08",
      "after": "Successful collections refresh changed derived inputs in dependency order and retry earlier failed refreshes. Derived chains are supported, own output is excluded, and cycles are rejected at definition time. Manual and automatic publication share storage admission and recoverable version switching.",
      "deployment_date": null,
      "status": "implemented, verified offline and integrated/pushed at ef44b77; live deployment not verified",
      "evidence": [
        "src/index.ts: refreshDerivedObjects, storeDerivedObject",
        "src/derived.ts: cycle checks",
        "test/review-regressions.test.ts",
        "test/derived-routes.test.ts",
        "1008-review-bug-repair-e003"
      ],
      "id": "C-006",
      "implementation_date": "2026-10-08",
      "domain": "derived objects / dependencies"
    },
    {
      "evidence": [
        "src/merge.ts: nameDocument, namingLabel, proxyReferenceProblem, canonicalForm",
        "test/merge-review-regressions.test.ts",
        "test/derived-routes.test.ts",
        "docs/research/2026-10-08-yaml-policy-references.md",
        "1008-review-bug-repair-e008"
      ],
      "domain": "structured YAML merge / source naming",
      "request": "1008-review-bug-repair-e007",
      "status": "implemented, verified offline and integrated/pushed at 0417fe7; deployment unverified",
      "deployment_date": null,
      "after": "Names are assigned per source before union, machine/path identity qualifies equal basenames, and static group members, routing action tokens, sub-rule policies and dialers follow their rename map. Ambiguous/dangling references refuse publication; structured comparison preserves __proto__ and distinguishes generated number tags from user mappings.",
      "requirement_date": "2026-10-08",
      "before": "Source-qualified proxy-group names do not update group member or rule target references; naming diagnostics include out-of-scope node names",
      "implementation_date": "2026-10-08",
      "rules": "Existing node names outside naming scope remain unchanged. No custom27group template or user-supplied scripts. Proxy configuration handling is bounded, not a complete dynamic-provider schema validator.",
      "main_integration_date": "2026-10-08",
      "id": "C-007"
    },
    {
      "request": "1008-review-bug-repair-e007",
      "requirement_date": "2026-10-08",
      "before": "Saved ordering was ignored, some missing/empty inputs produced partial replacement, invalid naming options were silently accepted/dropped, and cross-source terminal rules shadowed later specifics. Preview omitted entry/duplicate statistics.",
      "status": "implemented, verified offline and integrated/pushed at 0417fe7; deployment unverified",
      "domain": "derived processing / input completeness / rule precedence",
      "evidence": [
        "src/derived.ts: engineRule,engineSources,missingSourceProblem,mergeSignature,parseStoredRule",
        "src/merge.ts: mergeRoutingRules,nameFromSourceProblem",
        "src/index.ts: definitionFrom,refreshDerivedObjects",
        "test/merge-review-regressions.test.ts",
        "test/derived-routes.test.ts",
        "1008-review-bug-repair-e008"
      ],
      "implementation_date": "2026-10-08",
      "id": "C-008",
      "after": "Configured order controls concatenation and scalar conflicts. Every source pattern/input is required. Specific routing rules retain priority before one source-precedence MATCH; terminal conflicts are reported. Disjoint sub-rules merge and incompatible definitions refuse. Naming/stored-rule validation, per-source entry/dedup notes and transform-v2 signatures prevent silent stale or invalid results.",
      "deployment_date": null,
      "main_integration_date": "2026-10-08",
      "rules": "Failed runs preserve prior D1/R2 output. Invalid saved rules record merge_failed without blocking other refreshes. Existing8MiB aggregate text bound and single-secret/no-transaction architecture remain."
    },
    {
      "id": "C-009",
      "domain": "derived proxy configuration",
      "request": "1008-r2-file-manager-e001",
      "requirement_date": "2026-10-08",
      "implementation_date": "2026-10-08",
      "main_integration_date": null,
      "deployment_date": null,
      "before": "Generic YAML union creates 24 source groups and does not reproduce the existing merged-all profile",
      "after": "Bounded TypeScript proxy-profile reproduces the confirmed settings, source-prefixed node names,27groups and routing; eight real inputs compare semantically identical to target",
      "rules": "No uploaded script execution or committed node credentials; failed processing preserves previous output",
      "status": "implemented; focused offline tests passed, full validation/review pending",
      "evidence": [
        "src/merge.ts",
        "src/derived.ts",
        "1008-r2-file-manager-e003",
        "src/proxy-profile.ts:buildProxyProfile"
      ]
    },
    {
      "id": "C-010",
      "domain": "R2 file management / download links",
      "request": "1008-r2-file-manager-e001",
      "requirement_date": "2026-10-08",
      "implementation_date": "2026-10-08",
      "main_integration_date": null,
      "deployment_date": null,
      "before": "Stored-file browser and optional-password expiring share API lack upload, direct links and browser password confirmation",
      "after": "Manage stored files, download directly and create/revoke direct or password-confirmed sharing links",
      "rules": "Authenticated management; bearer direct links; password checked before streaming; preserve existing share API",
      "status": "implemented; focused offline tests passed, full validation/review pending",
      "evidence": [
        "src/index.ts",
        "src/ui.ts",
        "src/share.ts",
        "1008-r2-file-manager-e003"
      ]
    }
  ],
  "notes": "C-001/C-002 describe historical deployment and security cleanup before authentication and probe removal; their before/after statements are not current architecture. C-003 records the host form change. Collection, downloads and derived routes now exist; C-004/C-005/C-006 record the 2026-10-08 full-code repairs with offline verification, separately from unverified live deployment. See the latest checkpoint in .scratch/vps-file-hub/STATE.md."
}
