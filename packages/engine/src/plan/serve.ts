/**
 * The serving plan: what a login's runtime serves its programs by, every module of it one DbLayer.make loads — the
 * snapshot it is given and the fingerprint it records, the ledger and its statements, the slice a law model is compiled
 * for, and the basis it is compiled over. What only generate, check and migrate read is plan/migration.ts's, whose
 * modules a runtime never loads.
 */
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
export {
	type InstalledIndexes,
	servedSnapshot,
	snapshotIndexes
} from "#compiler/deploy/snapshot/served.ts"
export { rosterCodebook } from "#compiler/ir/codes.ts"
export {
	type CompileFacts,
	type DeploySnapshot,
	type IndexKeyColumn,
	type LawColumnHolds,
	manifestFileName,
	type ServedSnapshot,
	type SnapshotDerived,
	type SnapshotFiles,
	snapshotFileName,
	type SnapshotIndex,
	type SnapshotLevel,
	type SnapshotTable,
	type SnapshotTables
} from "#compiler/deploy/snapshot/types.ts"
export { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
export {
	type DescribedLaw,
	type InstallBasis,
	installBasis,
	type PlanBasis,
	planBasis
} from "#compiler/physical/install/plan.ts"
export { installationsOf } from "#compiler/schema/own.ts"
export {
	everySlice,
	type RoleProgram,
	type Slice,
	sliceOf,
	within
} from "#compiler/schema/reach.ts"
export {
	type ServedAbove,
	type ServedChange,
	type ServedContext,
	servedDirectory,
	type ServedEntryKey,
	type ServedFile,
	type ServedFootprint,
	type ServedInstantRead,
	type ServedReadLive,
	type LiveGap,
	type ServedLive,
	type UncoveredRead,
	type ServedKey,
	type ServedKeyLaws,
	type ServedMember,
	type ServedMemberForm,
	type ServedPage,
	type ServedPageRequest,
	type ServedPageProgram,
	type ServedParamDomain,
	servedPath,
	type ServedPrologue,
	type ServedRead,
	type ServedRefresh,
	type ServedRefreshTarget,
	type ServedRefusals,
	type ServedRoleForm,
	type ServedRoutes,
	type ServedSession,
	type ServedTable,
	type ServedTables,
	type ServedVariants
} from "#compiler/served/forms.ts"
export { servedFile } from "#compiler/served/json.ts"
export {
	type ServedAttach,
	type ServedAttached,
	type ServedCarried,
	type ServedChoice,
	type ServedForm,
	type ServedFused,
	type ServedPart,
	type ServedProgram,
	type ServedReadBack,
	type ServedRiddenSource,
	type ServedRoots,
	type ServedSource,
	type ServedSpec,
	type ServedSpine,
	type ServedSentStatement,
	type ServedSpineAttachment,
	type ServedTree,
	servedTree
} from "#compiler/served/read.ts"
