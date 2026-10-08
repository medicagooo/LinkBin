/**
 * Terminate bearer access when a logical file is removed. Replacements never call this.
 * Called before explicit deletion and capacity reclamation, so a failed byte deletion may cancel a link
 * but cannot leave a public capability waiting to revive on a later same-path private upload.
 * Storage primitives also support pre-0005 database-only consumers; absence of the table is intentional
 * there. Other database failures propagate rather than being mistaken for a successful cancellation.
 */
export async function revokeFileLinks(db: D1Database, hostId: string, path: string, at: string): Promise<void> {
  const present = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_links'").first();
  if (!present) return;
  await db.prepare('UPDATE file_links SET revoked_at = ? WHERE host_id = ? AND path = ? AND revoked_at IS NULL')
    .bind(at, hostId, path).run();
}
