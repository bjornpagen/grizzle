/**
 * The change plan: what a compiled ChangeSet is, and what the shell runs it by — its write program, the normalization of
 * its facts, its statements' binding, and the outcome, witness and refusal its rows are read into.
 */
export { generatedFieldLaws } from "#compiler/analysis/theory/description.ts"
export type { Family } from "#compiler/ir/family.ts"
export { generatedLaw } from "#compiler/ir/law.ts"
export type { FamilyId, TableRelation } from "#compiler/ir/law.ts"
export type {
	AnyChangeSet,
	ArraysOf,
	ChangeSet,
	FactsCheck,
	FactsShape,
	Law,
	PlannedStrata,
	Refused,
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
export type { Unsendable } from "#compiler/write/family/order.ts"
export type { WriteFrontend } from "#compiler/write/frontend/compile.ts"
export { entryKey, fillContexts } from "#compiler/write/frontend/entry.ts"
export type { WriteNames } from "#compiler/write/insert/statement.ts"
export { type GroupData, type MemberFacts, memberSlots } from "#compiler/runtime/write/normalize.ts"
export type { UniqueAbort, WriteStep } from "#compiler/runtime/write/steps.ts"
export type { ArtifactStatement, WriteArtifact } from "#compiler/write/program/artifact.ts"
export {
	bindWrite,
	type BoundWrite,
	type Chunks,
	type FamilyRowBound,
	type GeneratedRejection,
	type Raw,
	type RunnableWrite,
	runnableWrite
} from "#compiler/write/program/bind.ts"
export { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
export type { ExecutionPart } from "#compiler/write/program/staged.ts"
export {
	type FlightStatement,
	type FlightWrite,
	loadWrite,
	type ServedWrite
} from "#compiler/runtime/write/flight.ts"
export {
	projectWrite,
	servedWrite,
	type UnservedMember,
	type UnservedReason
} from "#compiler/write/program/served.ts"
export {
	interpretRows,
	type KeyDecoder,
	keyWitness,
	witnessDecoder
} from "#compiler/runtime/write/outcome.ts"
export {
	type HostJudgement,
	hostJudgement,
	type RefusedLaws,
	type Refuser,
	type StatementAt,
	statementRelations
} from "#compiler/runtime/write/witness.ts"
export {
	type ConcurrentChange,
	type LawDetail,
	readChangeDetail,
	readLawDetail
} from "#compiler/runtime/write/refusal.ts"
