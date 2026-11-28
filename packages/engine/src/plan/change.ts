/**
 * The change plan: what a compiled ChangeSet is, and what the shell runs it by — its write program, the normalization of
 * its facts, its statements' binding, and the outcome, witness and refusal its rows are read into.
 */
export { generatedFieldLaws } from "#compiler/analysis/theory/description.ts"
export type { Family } from "#compiler/ir/family.ts"
export { generatedLaw } from "#compiler/ir/law.ts"
export type { FamilyId, TableRelation } from "#compiler/ir/law.ts"
export type {
	AboveLaw,
	AboveRefusedLaw,
	AnyChangeSet,
	ArraysOf,
	ChangeSetOf,
	FactsCheck,
	KeyHost,
	Law,
	OwnLaw,
	PlannedStrata,
	RecordedLaw,
	BrokenLaws,
	DrawnBy,
	RefusedLaw,
	RefusingObject,
	StatedLaw,
	Witness,
	WritesOf
} from "#compiler/types/changeset/changeset.ts"
export {
	type ChangeSetInput,
	type ChangeSetValue,
	isChangeSetValue,
	parseChangeSet,
	type ParsedChangeSet
} from "#compiler/write/changeset/value.ts"
export { outcomeKind, type RelationCounts } from "#compiler/runtime/write/net.ts"
export { type BindFrame, inForce, type Transport } from "#compiler/runtime/write/transport.ts"
export type { WriteFrontend } from "#compiler/write/frontend/compile.ts"
export { claimsKeyOf, entryKeyOf, fillContexts } from "#compiler/write/frontend/entry.ts"
export {
	type ChangeEntry,
	type ChangeRefused,
	compileParsed,
	type CompiledVariants,
	loginChanges,
	parsedChange,
	type RoleChanges,
	type ServableEntry,
	servableEntry,
	type ServableRole,
	type ServableVariants,
	servableRole,
	servableRoles,
	variantsEntries
} from "#compiler/program/workload/change.ts"
export { noPlannedFrontends } from "#compiler/program/workload/planned.ts"
export { loginRole, programsOn } from "#compiler/program/workload/roles.ts"
export { factsDecoderOver } from "#compiler/program/decode.ts"
export { insertPreviewOver } from "#compiler/program/preview.ts"
export type { FactsDecoder } from "#compiler/types/changeset/decode.ts"
export type { InsertPreview } from "#compiler/types/changeset/preview.ts"
export {
	type ReadCalled,
	readCalled,
	type WorkloadProgram
} from "#compiler/program/workload/value.ts"
export type { WriteNames } from "#compiler/write/insert/statement.ts"
export { type GroupData, type MemberFacts, memberSlots } from "#compiler/runtime/write/normalize.ts"
export { valueBytes } from "#compiler/runtime/write/read-call.ts"
export type { UniqueAbort, WriteStep } from "#compiler/runtime/write/steps.ts"
export type { ArtifactStatement, WriteArtifact } from "#compiler/write/program/artifact.ts"
export {
	bindWrite,
	type BoundWrite,
	type Chunks,
	type GeneratedRejection
} from "#compiler/runtime/write/bind.ts"
export { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
export type { ExecutionPart } from "#compiler/runtime/write/executions.ts"
export type { ClosedRows } from "#compiler/ir/rel.ts"
export { closedNamed, type ClosedTable } from "#compiler/runtime/write/fill.ts"
export { closedTableOf } from "#compiler/analysis/schema.ts"
export {
	type FlightStatement,
	type FlightWrite,
	loadWrite,
	type ServedWrite,
	type WriteExclusion
} from "#compiler/runtime/write/flight.ts"
export { type ArrayMember, memberFactsOf } from "#compiler/runtime/write/members.ts"
export {
	flightOf,
	projectWrite,
	type ServableWrite,
	servableWrite,
	writeAdvice
} from "#compiler/write/program/served.ts"
export {
	interpretRows,
	type KeyDecoder,
	type KeyWitness,
	keyWitness,
	witnessDecoder
} from "#compiler/runtime/write/outcome.ts"
export {
	type AboveJudgement,
	aboveJudgement,
	type HostJudgement,
	hostJudgement,
	type RefusedLaws,
	type Refuser,
	type StatedRows,
	type StatementAt,
	statementRelations
} from "#compiler/runtime/write/witness.ts"
export {
	type ConcurrentChange,
	type LawDetail,
	readChangeDetail,
	readLawDetail
} from "#compiler/runtime/write/refusal.ts"
