/**
 * Public barrel: query, v, arm, and the typed query facade. packages/grizzle/src/index.ts re-exports it.
 *
 * query, v and arm are the query builder runtime (query/build), typed by their public signatures (types/query). The
 * query building blocks (Source, SelfSource, BoundSource, Carriers, Vars, Bindings, ParamOrigin, LiteralOrigin,
 * ComputedOrigin, Literal, Aggregate, Producer, ResultOf, ParamsOf, CommonKeys), an attachment's delivery (Arm,
 * DeliveryKind) and the evidence vocabulary (Evidence, EvidenceOf) are the public supporting types. Term and Predicate
 * are the compute barrel's, ALLEN the allen barrel's.
 */
export { arm } from "#compiler/query/build/attach.ts"
export { query, v } from "#compiler/query/build/query.ts"
export type {
	Carrier,
	Carriers,
	ComputedOrigin,
	InputOrigin,
	Literal,
	LiteralOrigin,
	Origin,
	ParamOrigin,
	SchemaSource,
	Source
} from "#compiler/types/core/phantom.ts"
export type { Evidence, EvidenceOf } from "#compiler/types/evidence/evidence.ts"

export type {
	Arm,
	BoundSource,
	CommonKeys,
	DeliveryKind,
	EvidenceOfQuery,
	Finished,
	HeadOf,
	ImmediateHeadOf,
	Ordered,
	ParamsOf,
	Query,
	QueryBuilder,
	SelfSource
} from "#compiler/types/query/query.ts"
export type { Rule } from "#compiler/types/query/rule.ts"
export type {
	Aggregate,
	Bindings,
	Producer,
	ResultOf,
	Vars,
	VarsOf
} from "#compiler/types/query/terms.ts"
