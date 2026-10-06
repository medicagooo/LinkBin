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
    }
  ],
  "active": ["vps-file-hub"],
  "pending": [],
  "read": [],
  "changes": [],
  "notes": "No business change has been implemented yet. This ledger records process/infrastructure events only until the first shippable behaviour exists. See .scratch/vps-file-hub/STATE.md for current phase."
}
