/**
 * The migration plan: what a migration is, and what the shell drafts, reviews and applies it by — the draft and its
 * folder, the snapshot it starts from and ends at, the ledger, and the installation it installs.
 */
export type { AbandonedSchema, Declarations, Named, Rename } from "#compiler/deploy/diff/plan.ts"
export {
	decideFolder,
	type LedgerRow,
	ledgerState,
	type LedgerState,
	ledgerStatements,
	type LedgerStatements,
	type RecordedFolder
} from "#compiler/deploy/ledger/ledger.ts"
export {
	type FolderNaming,
	folderTimestamp,
	isFolderName,
	lossDecisions,
	lossText,
	maxMigrationNameLength,
	metaFileName,
	metaSeal,
	type MigrationFolder,
	type MigrationMeta,
	type MigrationName,
	orderFolderFiles,
	parseMigrationName,
	readDecodedMeta,
	type ReadMeta,
	timestampLength,
	timestampWidths
} from "#compiler/deploy/render/folder.ts"
export {
	customMigration,
	type DraftInput,
	draftMigration,
	generateMigration,
	type GenerateResult,
	type MigrationDraft
} from "#compiler/deploy/render/generate.ts"
export {
	findMarkers,
	isNoTransaction,
	noTransactionMarker,
	splitStatements
} from "#compiler/deploy/render/markers.ts"
export {
	codebookOf,
	derivedHolds,
	emptyFingerprint,
	emptySnapshot,
	isEmptySnapshot,
	joinedSnapshot,
	noWorkload,
	rosterFates,
	snapshotFingerprint
} from "#compiler/deploy/snapshot/build.ts"
export { servedSnapshot } from "#compiler/deploy/snapshot/served.ts"
export {
	type DeploySnapshot,
	manifestFileName,
	type ServedSnapshot,
	type SnapshotDerived,
	type SnapshotFiles,
	type SnapshotLevel,
	snapshotFileName
} from "#compiler/deploy/snapshot/types.ts"
export { workloadExtension } from "#compiler/physical/access/extension.ts"
export { completeInstallOptions } from "#compiler/physical/complete.ts"
export { installationsOf } from "#compiler/schema/own.ts"
export { everySlice, loginSlice } from "#compiler/schema/reach.ts"
export { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
export { literalPackFault, type PackFault } from "#compiler/physical/ddl/literal.ts"
export { type Installation, installationOver } from "#compiler/physical/install/compile.ts"
export {
	type DescribedLaw,
	type InstallBasis,
	installBasis,
	type PlanBasis,
	planBasis
} from "#compiler/physical/install/plan.ts"
export {
	accessDrift,
	accessDriftText,
	compileWorkload
} from "#compiler/program/workload/compile.ts"
export { lex, type Token } from "#compiler/sql/lexer.ts"
