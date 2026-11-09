/**
 * The migration plan: what a migration is, and what generate, check and migrate draft, review and apply it by, every
 * module of it one a login's runtime never loads — the draft and its folder, its markers, the installation it installs
 * and the manifest it records, and the workload's access compile. What a runtime also reads, the snapshot, the ledger,
 * the slice and the basis, is plan/serve.ts's.
 */
export { type ManifestStatement, manifestStatements } from "#compiler/deploy/admission/manifest.ts"
export type { AbandonedSchema, Declarations, Named, Rename } from "#compiler/deploy/diff/plan.ts"
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
export { workloadExtension } from "#compiler/physical/access/extension.ts"
export { completeInstallOptions } from "#compiler/physical/complete.ts"
export { literalPackFault, type PackFault } from "#compiler/physical/ddl/literal.ts"
export { type Installation, installationOver } from "#compiler/physical/install/compile.ts"
export {
	accessDrift,
	accessDriftText,
	compileWorkload
} from "#compiler/program/workload/compile.ts"
export { servedRosters } from "#compiler/program/served.ts"
export { servedDifference, type ServedPart, servedPartText } from "#compiler/served/difference.ts"
export { servedText } from "#compiler/served/json.ts"
export { lex, type Token } from "#compiler/sql/lexer.ts"
export { servedMembers } from "#compiler/write/program/served-members.ts"
export { type UnservedMember, type UnservedReason } from "#compiler/write/program/served.ts"
