/**
 * The read plan: what a compiled read or page is, and what the shell runs and decodes it by — the template and its
 * programs, their statements, forms and placeholders, the codecs of their parameters and rows, and the cursor.
 */
export { getRefusal, requireGet } from "#compiler/analysis/logical/get.ts"
export { parentUse } from "#compiler/check/scan.ts"
export {
	cursorCodec,
	type CursorCodec,
	cursorTokenMaxLength
} from "#compiler/codec/cursor/codec.ts"
export { cursorError } from "#compiler/codec/cursor/fault.ts"
export type { CursorGeneration } from "#compiler/codec/cursor/identity.ts"
export { encodeFailure, factPlace, slotPlace } from "#compiler/codec/fault.ts"
export {
	columnLiteral,
	type NormalizedRelation,
	normalArray,
	type ParameterNormalizer,
	parameterNormalizer,
	positionalColumns,
	type RelationSpec,
	textArrayParam
} from "#compiler/codec/recordset.ts"
export {
	carrierSpecOf,
	countParam,
	paramEncoder,
	scalarCodec,
	type ScalarCodec,
	textParam
} from "#compiler/codec/scalar.ts"
export type { PageFill, SizeFill } from "#compiler/ir/products.ts"
export type { CompletedOrder, Heading, NodeOf, TakeBound } from "#compiler/ir/rel.ts"
export { columnPosition, columnType } from "#compiler/lower/conservative/context.ts"
export {
	type AttachedTree,
	type ConservativeParamSlot,
	type DeclaredParamSlot,
	flight,
	type GroupMerge,
	keyColumns,
	mapTree,
	type PageStatementSlot,
	type ProgramDelivery,
	type RelationColumn,
	statementOutput,
	type StatementOutput,
	type StatementRoots,
	type StatementTree,
	traverseTree
} from "#compiler/lower/conservative/types.ts"
export {
	type FusedAttachment,
	fusedTexts,
	type FusedTexts
} from "#compiler/lower/shapes/attach/decode.ts"
export type {
	Arrival,
	FusedStatement,
	RelationChoice,
	ShapeChoice,
	StatementForms
} from "#compiler/lower/shapes/index.ts"
export {
	compilePageOf,
	type PageArtifact,
	type PageProbeProgram,
	type PageProgram,
	type PageRequestProgram,
	type PageStatement,
	type PageTemplate,
	statedOrderOf
} from "#compiler/lower/shapes/page/compile.ts"
export type {
	AnchoredVariant,
	PageComparator,
	PageDirection,
	PageVariant,
	ProbeKind,
	VariantFill
} from "#compiler/lower/shapes/page/seek.ts"
export {
	type ChoiceInput,
	type RelationInput,
	runsLargeForm
} from "#compiler/lower/shapes/take/index.ts"
export { mergeHeadingGroups } from "#compiler/lower/shapes/union/index.ts"
export {
	pageStatementSlotOf,
	type SpecifiedStatement,
	statementSpec
} from "#compiler/lower/template.ts"
export { queryInput, type QueryInput, type QueryTemplate } from "#compiler/program/compile.ts"
export { servedPage, servedRead } from "#compiler/program/served.ts"
export {
	type CompiledTemplate,
	type ExecutionRequest,
	templateFor
} from "#compiler/program/template.ts"
export { pageQueryFingerprint } from "#compiler/program/workload/fingerprint.ts"
export { workloadState } from "#compiler/program/workload/value.ts"
export { hostArguments } from "#compiler/query/build/host.ts"
export { isOrderedValue, isQueryValue } from "#compiler/query/build/index.ts"
export { keyLookup, keyQuery } from "#compiler/query/build/key.ts"
export { queryState } from "#compiler/query/build/state.ts"
export { type CarrierHost, compareValues } from "#compiler/scalar/values/identity.ts"
export { servedSource } from "#compiler/served/read.ts"
export { servedSpine } from "#compiler/served/spine.ts"
export type {
	Page,
	PageCursor,
	PageEdge,
	PageInfo,
	PageRequest
} from "#compiler/types/page/page.ts"
export type {
	ContextsOf,
	EvidenceOfQuery,
	Ordered,
	OrderedBase,
	PageOf,
	ParamsOf,
	Query,
	QueryBase,
	UnionArms
} from "#compiler/types/query/query.ts"
