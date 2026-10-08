# UI layout repair

Status: approved by the current repair/review/push-main request

Repair the five panels identified on the live page: stored files, storage, shared links, combined files and collection history. Use the existing frontend and authenticated APIs; do not change storage or sharing contracts.

## Required behavior

- Every panel has consistent inner spacing. Labels, file names and combination options remain readable at 375, 560, 828 and 1280 CSS pixels in en, zh-CN, zh-TW and ja, with light and dark themes.
- Navigate between Files, Links, Merges, Collection and Hosts/rules without a long stack of unrelated forms. Preserve keyboard access, panel state, language and appearance controls.
- Show a pending upload queue with names and sizes, enforce the existing 100 MiB per-file bound before transmission, report each result and allow retry of failed items. Keep uploads sequential and use existing server admission; never invent byte progress.
- Create password shares from a selected available file, show its name/source, and replace the primary numeric-id input with file selection. Keep fixed-version password shares and revocable latest-version direct links distinct. Report clipboard success only after copying succeeds and provide manual fallback.
- Show storage totals, remaining/protected/retained bytes and capacity warnings; provide a largest-file shortcut. Keep the existing 10 GiB budget and important-object protection.
- Preview merges with matched files, missing sources and conflicts. The eight-source merged-all preset must make completeness visible. Saving does not imply running; successful runs expose download and refresh files, usage and merge state.
- Show real collection results including unreachable, stopped and nothing-to-do states. Disable collection without an enabled host. Refresh receipts, freshness, files, usage and merges after a run.
- Show loading, empty, error and retry states for data sections. Validate operation prerequisites and avoid duplicate in-flight submissions.

## Verification and boundary

Use an offline DOM harness against the emitted UI script for behavior regressions, visual browser checks against a local mocked page for responsive CSS, existing Workers tests for API compatibility, both guards and Worker dry-run. Standards and Spec reviews use the original base 6282b5129dabe6c11b7c27d3cdfa894cf410b806. No direct cloud write, deployment, migration, new secret or arbitrary uploaded code execution is authorized.
