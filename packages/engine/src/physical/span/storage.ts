import { contractLaw } from "#compiler/analysis/theory/description.ts"
import { Refusal } from "#compiler/core/canonical.ts"
import {
	type DeclaredName,
	type Identity,
	identifierOf,
	identity
} from "#compiler/core/identity.ts"
import { type ConstraintName, ExprId, type LawId, NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { firstCalendarDate, lastCalendarDate } from "#compiler/ir/date.ts"
import {
	builtExpr,
	type ExprTable,
	type LiveArgs,
	mapArgs,
	predicateTree,
	sameArgs,
	type ScalarExpr
} from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import type { LawField, TheoryRelation } from "#compiler/ir/law.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import {
	baseOf,
	contractOf,
	type ScalarType,
	type SpanCarrier,
	spanCarrierOf,
	spanOf
} from "#compiler/ir/scalar.ts"
import type { ConstraintLaw, LawModel } from "#compiler/laws/model/model.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { lowerPersistent, persistentClosed } from "#compiler/physical/ddl/expr.ts"
import { enforcement, lawReasons } from "#compiler/physical/obligations/graph.ts"
import { definedRangeOp } from "#compiler/scalar/compute/registry.ts"
import type { Expr, TableConstraint } from "#compiler/sql/ast.ts"
import { and, binary, call, cast, eq, lit, not, tableCol, types } from "#compiler/sql/build.ts"

/** One CHECK of one span column, with its name and the reasons its physical object carries: its shape, its fixed width,
 * or an endpoint CHECK, which substitutes the predicate of a contract along the endpoint's chain and stands after that
 * contract's domain. */
type SpanConstraint = {
	readonly relation: StoredRelation
	readonly named: Identity<"spanCheck">
	readonly constraint: TableConstraint & { readonly kind: "check"; readonly name: ConstraintName }
	readonly reasons: ReadonlyArray<PhysicalReason>
} & (
	| { readonly kind: "shape" | "width" }
	| { readonly kind: "endpoint"; readonly contract: DeclaredName }
)

type StoredRelation = Extract<TheoryRelation, { readonly kind: "relation" }>

/** A span column type's range carrier, its endpoint, and its fixed width when it has one. */
interface SpanColumnInfo {
	readonly carrier: SpanCarrier
	readonly endpoint: ScalarType
	readonly width: bigint | undefined
}

/** The span information of a column type, or undefined when the column is no span. */
const spanColumnInfo = (t: ScalarType): SpanColumnInfo | undefined => {
	const b = baseOf(t)
	const carrier = spanCarrierOf(b)
	const span = spanOf(b)
	return carrier === undefined || span === undefined
		? undefined
		: { carrier, endpoint: span.endpoint, width: span.width }
}

/**
 * The span shape over the column: nonempty, bounded on both sides, lower bound inclusive and upper bound exclusive;
 * over dates, its endpoints among the days a CalendarDate spells, 0001-01-01 to 9999-12-31, which PostgreSQL's date
 * exceeds.
 */
const spanShapePredicate = (column: string, carrier: SpanCarrier): Expr => {
	const c = tableCol(column)
	const shape = [
		not(call("isempty", [c])),
		not(call("lower_inf", [c])),
		not(call("upper_inf", [c])),
		call("lower_inc", [c]),
		not(call("upper_inc", [c]))
	] as const
	return carrier === "rangeDate"
		? and([
				...shape,
				binary(">=", call("lower", [c]), lit.text(firstCalendarDate, types.date)),
				binary("<=", call("upper", [c]), lit.text(lastCalendarDate, types.date))
			])
		: and(shape)
}

/**
 * The fixed width over the column: upper(c)::numeric - lower(c)::numeric = <width> over integers, both endpoints cast
 * to numeric so no width at the endpoint type's limits overflows; upper(c) - lower(c) = <width> over dates, whose
 * difference is the integer count of days between them.
 */
const spanWidthPredicate = (column: string, width: bigint, carrier: SpanCarrier): Expr => {
	const c = tableCol(column)
	return carrier === "rangeDate"
		? eq(binary("-", call("upper", [c]), call("lower", [c])), lit.int(width, types.integer))
		: eq(
				binary(
					"-",
					cast(call("upper", [c]), types.numeric),
					cast(call("lower", [c]), types.numeric)
				),
				lit.int(width, types.numeric)
			)
}

/** A contract along an endpoint's chain that has a predicate: its name and its predicate's table. */
interface PredicatedContract {
	readonly name: DeclaredName
	readonly predicate: ExprTable
}

/** The contracts with a predicate along an endpoint's contract chain, outermost first. */
const endpointContracts = (endpoint: ScalarType): ReadonlyArray<PredicatedContract> => {
	const out: Array<PredicatedContract> = []
	for (
		let contract = contractOf(endpoint);
		contract !== undefined;
		contract = contractOf(contract.base)
	) {
		if (contract.predicate !== undefined) {
			out.push({ name: contract.name, predicate: contract.predicate })
		}
	}
	return out
}

/** The column a substituted endpoint node reads; the substitution's column scope resolves it to the span column. */
const spanColumnNode = NodeId("span")

/** The endpoint function of each bound. */
const endpointFunctions = { lower: "lower(anyrange)", upper: "upper(anyrange)" } as const

/** The contract predicate's tree with each VALUE replaced by `bound(c)`, the span endpoint function over the column.
 * The endpoint node keeps VALUE's type, the contract's base, which is the endpoint's own carrier. */
const substituteEndpoint = (
	predicate: ScalarExpr,
	bound: "lower" | "upper",
	field: string,
	spanType: ScalarType,
	carrier: SpanColumnInfo["carrier"]
): ScalarExpr => {
	const substituted = new Fold<ScalarExpr, ScalarExpr>(function* (e) {
		if (e.kind === "value") {
			const column = builtExpr(
				{
					kind: "column",
					column: { node: spanColumnNode, name: field },
					args: [],
					type: spanType,
					nonNull: "storage"
				},
				ExprId(`${e.id}~${bound}`)
			)
			return builtExpr(
				{
					kind: "op",
					op: definedRangeOp(endpointFunctions[bound], carrier),
					args: [column],
					type: e.type,
					nonNull: "strict",
					volatility: "immutable"
				},
				e.id
			)
		}
		const spec = yield* mapArgs<LiveArgs, LiveArgs>(e)
		return sameArgs(e, spec) ? e : builtExpr(spec, e.id)
	})
	return substituted.of(predicate)
}

/** The endpoint CHECK predicate of one contract over the span column: P(lower(c)) AND P(upper(c)). */
const spanEndpointPredicate = (
	b: InstallBuilder,
	relation: string,
	field: string,
	spanType: ScalarType,
	contract: PredicatedContract,
	carrier: SpanColumnInfo["carrier"]
): Expr => {
	const column = b.names.column(relation, field)
	const predicate = predicateTree(contract.predicate)
	if (!predicate.ok) {
		throw new Refusal(predicate.error)
	}
	const side = (bound: "lower" | "upper"): Expr => {
		const substituted = substituteEndpoint(predicate.value, bound, field, spanType, carrier)
		return lowerPersistent(b.names, substituted, {
			reads: { kind: "row", column: (ref) => (ref.name === field ? column : undefined) },
			closed: persistentClosed(b.checked),
			loc: SourceLoc(
				`the ${bound} endpoint check of ${relation}.${field} over contract ${contract.name}`,
				[]
			)
		})
	}
	return and([side("lower"), side("upper")])
}

/** The laws of a contract: those its domain's native object enforces. */
const contractLaws = (model: LawModel, contract: DeclaredName): ReadonlyArray<LawId> =>
	model.natives.flatMap(({ object }) =>
		object.kind === "Domain" && object.name === contract ? object.lawIds : []
	)

/** An endpoint CHECK of a span column: the contract along the endpoint's chain whose predicate it substitutes, its name
 * minted at the naming door, and the laws a violation reports, the contract's own. */
interface SpanEndpoint {
	readonly contract: PredicatedContract
	readonly named: Identity<"spanCheck">
	readonly laws: ReadonlyArray<LawId>
}

/** A span column of a stored relation: its field, its span information, and one endpoint CHECK per contract with a
 * predicate along its endpoint's chain, outermost first. */
export interface SpanColumn {
	readonly relation: StoredRelation
	readonly field: LawField
	readonly info: SpanColumnInfo
	readonly endpoints: ReadonlyArray<SpanEndpoint>
}

/** Every stored relation's span columns, in relation name order, then field order. */
export const spanColumns = (model: LawModel): ReadonlyArray<SpanColumn> =>
	Object.values(model.theory.relations)
		.flatMap((r) => (r.kind === "relation" ? [r] : []))
		.toSorted((x, y) => compareStrings(x.name, y.name))
		.flatMap((relation) =>
			relation.fields.flatMap((field): ReadonlyArray<SpanColumn> => {
				const info = spanColumnInfo(field.type)
				return info === undefined
					? []
					: [
							{
								relation,
								field,
								info,
								endpoints: endpointContracts(info.endpoint).map((contract) => ({
									contract,
									named: identity.spanCheck(relation.name, field.name, {
										kind: "endpoint",
										contract: contract.name
									}),
									laws: contractLaws(model, contract.name)
								}))
							}
						]
			})
		)

/** Each span endpoint CHECK with the law a violation reports, for the constraint-to-law map: an endpoint CHECK reports
 * its contract's law, described as the contract, because the library evaluates no contract predicate; the shape and
 * width CHECKs report none, because a span value's codec refuses an empty, unbounded or reversed span and one whose
 * width differs from the column's fixed width before any SQL is sent (`admitSpan`), and grizzle's own span producers
 * never make one. */
export const spanConstraintLaws = (
	columns: ReadonlyArray<SpanColumn>
): ReadonlyArray<ConstraintLaw> =>
	columns.flatMap((c) =>
		c.endpoints.flatMap((e): ReadonlyArray<ConstraintLaw> => {
			const [law] = e.laws
			return law === undefined
				? []
				: [
						{
							kind: "constraint",
							name: identifierOf(e.named),
							owner: c.relation.ident,
							laws: [{ law, described: contractLaw(e.contract.name) }]
						}
					]
		})
	)

/** One of a span column's CHECKs, its name kept for the installation's census. */
const spanCheck = (
	b: InstallBuilder,
	named: Identity<"spanCheck">,
	predicate: Expr
): Pick<SpanConstraint, "named" | "constraint"> => ({
	named,
	constraint: { kind: "check", name: b.name(named), predicate }
})

/** The CHECKs of one span column: its shape, its width, then its endpoint CHECKs. Throws a Refusal, which the
 * installer's boundary turns into a failure. */
const spanColumnConstraints = (b: InstallBuilder, c: SpanColumn): ReadonlyArray<SpanConstraint> => {
	const relation = c.relation.name
	const field = c.field.name
	const column = b.names.column(relation, field)
	const label = `${relation}.${field}`
	const shape: SpanConstraint = {
		relation: c.relation,
		kind: "shape",
		...spanCheck(
			b,
			identity.spanCheck(relation, field, { kind: "shape" }),
			spanShapePredicate(column, c.info.carrier)
		),
		reasons: [enforcement(`span shape of ${label}: nonempty, bounded and half-open`)]
	}
	const width = c.info.width
	return [
		shape,
		...(width === undefined
			? []
			: [
					{
						relation: c.relation,
						kind: "width",
						...spanCheck(
							b,
							identity.spanCheck(relation, field, { kind: "width" }),
							spanWidthPredicate(column, width, c.info.carrier)
						),
						reasons: [enforcement(`span width ${width} of ${label}`)]
					} as const
				]),
		...c.endpoints.map((e): SpanConstraint => ({
			relation: c.relation,
			kind: "endpoint",
			contract: e.contract.name,
			...spanCheck(
				b,
				e.named,
				spanEndpointPredicate(b, relation, field, c.field.type, e.contract, c.info.carrier)
			),
			reasons:
				e.laws.length > 0
					? lawReasons(e.laws)
					: [enforcement(`span endpoints of ${label} in contract ${e.contract.name}`)]
		}))
	]
}

/** The span CHECKs as physical objects: each an `ALTER TABLE ... ADD CONSTRAINT ... CHECK` in Structure after its
 * table, and an endpoint CHECK after its contract's domain when the installation has one, so the installation reads as
 * the domain first. On a fresh installation the table is empty, so the CHECK is the one a hand-written CREATE TABLE
 * declares inline. */
const addSpanChecks = (b: InstallBuilder, constraints: ReadonlyArray<SpanConstraint>): void => {
	for (const c of constraints) {
		const domain = c.kind === "endpoint" ? b.domainOf(c.contract) : undefined
		b.add(
			{
				kind: "check",
				ident: {
					kind: "constraint",
					schema: b.names.levelOf(c.relation.name),
					relation: b.names.relationNamed(c.relation.name),
					name: c.named
				},
				ddl: [
					{
						kind: "alterTable",
						table: b.names.relation(c.relation.name),
						actions: [{ kind: "addConstraint", constraint: c.constraint, notValid: false }]
					}
				],
				reasons: c.reasons,
				phase: "structure"
			},
			[b.table(c.relation.name), ...(domain === undefined ? [] : [domain])]
		)
	}
}

/** Span storage: the CHECKs every span column of the plan's (`spanColumns`) carries, as physical objects.
 *
 * A span is one base range column, int4range over an integer endpoint, int8range over a bigint one and daterange over a
 * date, NOT NULL like every column. The table never stores two public endpoint columns. Beside the column, every writer meets these native
 * CHECKs, each wrapped in IS TRUE by the printer:
 *
 * - the shape, `<table>__check__<column>_span`: `NOT isempty(c) AND NOT lower_inf(c) AND NOT upper_inf(c) AND
 *   lower_inc(c) AND NOT upper_inc(c)`. PostgreSQL canonicalizes a discrete range to the half-open form, so an
 *   alternate spelling that normalizes to a valid value is accepted and the CHECK validates the stored value;
 * - a fixed width, `<table>__check__<column>_width`: `upper(c)::numeric - lower(c)::numeric = <width>`, both endpoints
 *   cast to numeric before the subtraction so no width at the endpoint type's limits overflows;
 * - a contract endpoint, `<table>__check__<column>_<contract>` for each contract with a predicate in the endpoint's
 *   chain, outermost first: the contract's predicate with lower(c) and then upper(c) substituted for VALUE, as one
 *   conjunction. A span over a contract stores the base range, never a range over the domain, so these CHECKs carry
 *   what the domain would check of each endpoint; a violation reports the contract's law, as the domain's own CHECK
 *   does. A brand-only contract, such as an Instant with no predicate, adds none.
 *
 * The substitution reuses the persistent lowering (`lowerPersistent`) over the contract's own predicate table, with
 * VALUE replaced by the span endpoint node `lower(anyrange)` or `upper(anyrange)` over the column, so the endpoint CHECK
 * and the domain CHECK are one native expression tree over different operands.
 *
 * Every name is minted at the naming door from the CHECK's identity (identity.spanCheck). The CHECKs are their
 * own physical objects in Structure, after their table. Every installation adds them before any caller extension runs
 * (physical/install/compile.ts installationOver), so no installation path can leave them out. */
export const addSpanStorage = (b: InstallBuilder, columns: ReadonlyArray<SpanColumn>): void => {
	addSpanChecks(
		b,
		columns.flatMap((c) => spanColumnConstraints(b, c))
	)
}
