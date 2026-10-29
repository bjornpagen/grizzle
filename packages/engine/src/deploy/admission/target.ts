import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"

/** Why a registered snapshot is not the application's, or undefined when it is.
 * Admission verifies that the database holds the snapshot the application knows: the latest complete migration's
 * target fingerprint must be that snapshot's. The application knows the snapshot it commits beside its code,
 * `migrations/<schema>/snapshot.json`, and passes it to every Db.open; admission never derives one from the schema
 * alone. A registered or passed snapshot must be of the application's schema: its owned schema's fingerprint is the
 * compiled schema's, and it is installed in the schema the compiled names place the relations in. */
export const snapshotMismatch = (
	snapshot: DeploySnapshot,
	expected: { readonly fingerprint: SchemaFingerprint; readonly schema: string }
): string | undefined => {
	if (snapshot.schema !== expected.schema) {
		return `a snapshot of schema ${expected.schema}, not of ${snapshot.schema}`
	}
	if (snapshot.theory.schema !== expected.fingerprint) {
		return `a snapshot of the application's schema ${expected.fingerprint}, not of ${snapshot.theory.schema}`
	}
	return undefined
}
