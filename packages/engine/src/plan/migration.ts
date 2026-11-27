/**
 * The migration plan: what a migration is, and what generate, check and migrate draft, review and apply it by, every
 * module of it one a login's runtime never loads — the draft and its folder, its markers, the installation it installs
 * and the manifest it records, and the workload's access compile. What a runtime also reads, the snapshot, the ledger,
 * the footprint and the basis, is plan/serve.ts's.
 */
export {
	type InstalledStatements,
	type ManifestStatement,
	manifestStatements,
	type RecordedSource,
	recordedSources,
	type ReplayedObject
} from "#compiler/deploy/admission/manifest.ts"
export {
	type ProofDigest,
	proofDigests,
	type ProvedObject,
	replayedOver
} from "#compiler/deploy/admission/proof.ts"
export {
	proofColumns,
	proofsIdent,
	type ProofStatements,
	proofStatements
} from "#compiler/deploy/ledger/ledger.ts"
export {
	loadedModuleColumns,
	planAdviceModule,
	proofsTableName
} from "#compiler/physical/ddl/ledger.ts"
export {
	dataStepBracket,
	immutableTriggerName,
	immutableTruncateTriggerName,
	standUpCalls
} from "#compiler/physical/ddl/immutable.ts"
export {
	type GraphIdent,
	namedIdent,
	parseIdent,
	qualifiedIdent
} from "#compiler/physical/obligations/graph.ts"
export {
	type AbandonedSchema,
	type Declarations,
	noDeclarations,
	type Rename
} from "#compiler/deploy/diff/plan.ts"
export { type Named, namedSpelling } from "#compiler/core/errors.ts"
export { decideFolder, type Redraft } from "#compiler/deploy/ledger/decide.ts"
export { replayLocks } from "#compiler/deploy/locks/demand.ts"
export {
	type FolderLaws,
	type FolderNaming,
	folderParts,
	isFolderName,
	lossDecisions,
	lossText,
	metaFileName,
	metaSeal,
	type MigrationFolder,
	type MigrationMeta,
	type MigrationName,
	orderFolderFiles,
	parseMigrationName,
	readDecodedMeta,
	type ReadMeta,
	statedLocks,
	timestampParts,
	timestampText
} from "#compiler/deploy/render/folder.ts"
export { timestampLength, type TimestampParts } from "#compiler/deploy/render/layout.ts"
export {
	generatedFileMaxBytes,
	isEntryOf,
	type LaidOutFile,
	laidOut,
	laidOutFiles
} from "#compiler/deploy/render/parts.ts"
export {
	customMigration,
	type DraftInput,
	draftMigration,
	generateMigration,
	type GenerateResult,
	type MigrationDraft,
	planMigration,
	type PlannedDraft,
	renderMigration
} from "#compiler/deploy/render/generate.ts"
export type { Spellings } from "#compiler/ir/pattern.ts"
export {
	findMarkers,
	isNoTransaction,
	noTransactionMarker,
	splitStatements,
	textLines
} from "#compiler/deploy/render/markers.ts"
export {
	derivedFacts,
	writeRuntimeSnapshot,
	writeSnapshot
} from "#compiler/deploy/snapshot/build.ts"
export { decoderLoginOf } from "#compiler/deploy/snapshot/objects.ts"
export {
	type Borrow,
	type BorrowAt,
	type BorrowLock,
	type BorrowMode,
	type Giver,
	type IsolationCondition,
	type IsolationReason,
	type KeyField,
	type KeySite,
	type KeySource,
	type LockOrder,
	type OwnCondition,
	type ReasonAt,
	reasonsOf,
	type Serializable
} from "#compiler/core/certificate.ts"
export { servedWorkloadExtension } from "#compiler/physical/access/extension.ts"
export { completeInstallOptions } from "#compiler/physical/complete.ts"
export { literalPackFault, type PackFault } from "#compiler/physical/ddl/literal.ts"
export type { Installation } from "#compiler/physical/install/compile.ts"
export { type IndexResolver, resolverOf } from "#compiler/physical/indexes/ref.ts"
export { type Advice, noAdvice } from "#compiler/sql/advice.ts"
export {
	type InstalledIdentifier,
	installationOver,
	installedIdentifiersOf
} from "#compiler/program/install.ts"
export {
	accessDrift,
	accessDriftText,
	compileWorkload,
	loginFootprints,
	planWorkload,
	type ProgramFootprints,
	type ServedWorkloadPlan,
	servedPrograms,
	servedWorkload,
	servesRead,
	withProgramAccess,
	type WorkloadFootprints,
	type WorkloadPlanRefused
} from "#compiler/program/workload/compile.ts"
export type { Footprint, Routes } from "#compiler/logical/routes.ts"
export { servedRosters } from "#compiler/program/served.ts"
export { servedDifference, servedPartingText } from "#compiler/served/difference.ts"
export { servedText } from "#compiler/served/json.ts"
export { memberWire, roleWire } from "#compiler/live/member.ts"
export { type UnservedMember, type UnservedReason } from "#compiler/served/unserved.ts"
export { filledText } from "#compiler/sql/emit.ts"
export { leadingTokens, lex, type Token } from "#compiler/sql/lexer.ts"
export {
	dataStepRecheckName,
	identifierOf,
	identity,
	type InstallationRole,
	installationRoleOf,
	liveSlotOf,
	type InstalledRoleTooLong,
	roleInSpace,
	type RoleSpace,
	standUpDisplayLead
} from "#compiler/core/identity.ts"
export {
	type InstallationNames,
	resolveVariables,
	type Variable,
	type VariableFault,
	variableOf
} from "#compiler/deploy/render/variables.ts"
export { servedMembers } from "#compiler/write/program/served-members.ts"
export { servedMatchers } from "#compiler/served/matchers.ts"
export { dropLiveSlot } from "#compiler/physical/ddl/live.ts"
export {
	type PlannedCall,
	type PlannedQueries,
	plannedQueries,
	readCall,
	writeCall
} from "#compiler/program/planned.ts"
export { enterQuery } from "#compiler/deploy/ledger/ledger.ts"
