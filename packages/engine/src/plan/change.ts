/**
 * The change plan: what a compiled ChangeSet is, and what the shell runs it by — its write program, the normalization of
 * its facts, its statements' binding, and the outcome, witness and refusal its rows are read into.
 */
export { generatedFieldLaws, generatedLaw } from "#compiler/analysis/theory/description.ts"
export type { Family } from "#compiler/ir/family.ts"
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
export { outcomeKind, type RelationCounts } from "#compiler/write/delta/net.ts"
export {
	type BindFrame,
	inForce,
	type Transport,
	type Unsendable
} from "#compiler/write/family/order.ts"
export type { WriteFrontend } from "#compiler/write/frontend/compile.ts"
export { entryKey, fillContexts } from "#compiler/write/frontend/entry.ts"
export type { WriteNames } from "#compiler/write/insert/statement.ts"
export {
	type GroupData,
	type MemberFacts,
	memberSlots
} from "#compiler/write/normalize/normalize.ts"
export type {
	ArtifactStatement,
	UniqueAbort,
	WriteArtifact,
	WriteStep
} from "#compiler/write/program/artifact.ts"
export {
	bindWrite,
	type BoundWrite,
	type Chunks,
	type FamilyRowBound,
	type GeneratedRejection,
	type Raw
} from "#compiler/write/program/bind.ts"
export { type CompiledWrite, compileWrite } from "#compiler/write/program/compile.ts"
export type { ExecutionPart } from "#compiler/write/program/staged.ts"
export {
	type FlightStatement,
	type FlightWrite,
	flightOf,
	loadWrite,
	projectWrite,
	type ServedWrite,
	servedWrite,
	type UnservedMember,
	type UnservedShape
} from "#compiler/write/program/served.ts"
export {
	interpretRows,
	type KeyDecoder,
	keyWitness,
	witnessDecoder
} from "#compiler/write/program/outcome.ts"
export {
	type HostJudgement,
	hostJudgement,
	type RefusedLaws,
	type Refuser,
	type StatementAt,
	statementRelations
} from "#compiler/write/program/witness.ts"
export {
	type ConcurrentChange,
	type LawDetail,
	readChangeDetail,
	readLawDetail
} from "#compiler/write/refusal.ts"
