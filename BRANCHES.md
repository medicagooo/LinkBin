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
    }
  ],
  "active": ["vps-file-hub", "ssh-probe"],
  "pending": [],
  "remote": {
    "origin": "git@github.com:medicagooo/LinkBin.git",
    "url": "https://github.com/medicagooo/LinkBin",
    "visibility": "PUBLIC",
    "default_branch": "main",
    "last_verified_main": "3880cd5f8aa4fd5f55d53149bd66de651335a505",
    "verified_at": "2026-10-07T03:57:00+08:00"
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
      "evidence": ["vps-file-hub-e024", ".scratch/vps-file-hub/STATE.md"],
      "before": "LinkBin existed only as source. The account held no linkbin Worker, D1 database or R2 bucket, so nothing was reachable and the SSH channel could not be exercised at all.",
      "after": "Worker \"linkbin\" is live at https://linkbin.cyc-xiaochen.workers.dev with D1 database linkbin-db, R2 bucket linkbin-files and the SSH_MASTER_KEY secret. The schema is applied (hosts, source_rules, objects, multipart_sessions), so hosts plus credentials and collection rules can be managed at runtime through the web UI without a redeploy.",
      "rules": "R2 bucket_name is pinned in wrangler.jsonc; database_name is pinned but database_id is deliberately absent, so the repository carries no account-specific resource ID. SSH_MASTER_KEY is write-once: replacing it makes every stored credential undecryptable.",
      "side_effects": "The UI and the /probe routes have NO authentication (D35). Anyone reaching the Worker can manage hosts and credentials; the /probe routes reach a stored host. Accepted by the user as a private-tool risk.",
      "status": "deployed; feature incomplete (store-verified collection and download are not built)"
    }
  ],
  "notes": "C-001 is the first business-relevant entry: it is a deployment of an incomplete feature, not a finished capability. Collection, download and consumer-facing download are still unbuilt. See .scratch/vps-file-hub/STATE.md for the current phase."
}
