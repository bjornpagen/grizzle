import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"

/** Why a registered snapshot is not the application's, or undefined when it is.
 * Admission verifies that the database holds the snapshot the application knows: the latest complete migration's
 * target fingerprint must be that snapshot's. The application knows the snapshot it commits beside its code,
 * `migrations/<root>/snapshot.json`, and passes it to every Db.open; admission never derives one from the schema
 * alone. A registered or passed snapshot must be of an installation one of whose levels is the application's schema
 * (adapter/admission/snapshots.ts servedLevel), installed in the schema the compiled names place the installation's
 * own objects in, its root's. */
export const snapshotMismatch = (
	snapshot: DeploySnapshot,
	expected: { readonly schema: string }
): string | undefined =>
	snapshot.schema === expected.schema
		? undefined
		: `a snapshot of schema ${expected.schema}, not of ${snapshot.schema}`
