/**
 * Public barrel: query, v, param, and the typed query facade. packages/grizzle/src/index.ts re-exports it.
 *
 * query, v and param are the query builder runtime (query/build), typed by their public signatures (types/query). The
 * query building blocks (Source, SelfSource, BoundSource, Carriers, Bindings, CarriersOf, ParamOrigin,
 * ConstantOrigin, LiteralOrigin, ComputedOrigin, Literal, Aggregate, Producer, ResultOf, ParamsOf, ParamType,
 * ParamArg, DeliveredKeys, DeliveredHeading), a union's arms (UnionArm, ArmStage), a record of reads as one query
 * (ReadsQuery over ReadsChildren, query(S).reads(R)'s type) and the evidence vocabulary (Evidence, EvidenceOf) are the
 * public supporting types. Term and Predicate are the compute barrel's, ALLEN the allen barrel's.
 */
export { query, v } from "#compiler/query/build/query.ts"
export { param } from "#compiler/query/build/rule.ts"
export type {
	Carrier,
	Carriers,
	ComputedOrigin,
	ConstantOrigin,
	InputOrigin,
	Literal,
	LiteralOrigin,
	Origin,
	ParamArg,
	ParamOrigin,
	ParamType,
	SchemaSource,
	Source
} from "#compiler/types/core/phantom.ts"
export type { Evidence, EvidenceOf } from "#compiler/types/evidence/evidence.ts"

export type {
	ArmStage,
	BoundSource,
	DeliveredHeading,
	DeliveredKeys,
	EvidenceOfQuery,
	Finished,
	HeadOf,
	ImmediateHeadOf,
	Ordered,
	ParamsOf,
	Query,
	QueryBuilder,
	ReadsChildren,
	ReadsQuery,
	SelfSource,
	UnionArm
} from "#compiler/types/query/query.ts"
export type { Rule } from "#compiler/types/query/rule.ts"
export type {
	Aggregate,
	Bindings,
	CarriersOf,
	Producer,
	ResultOf,
	VarsOf
} from "#compiler/types/query/terms.ts"
