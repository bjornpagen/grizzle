import { contractLaw } from "#compiler/analysis/theory/description.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	type DeclaredName,
	type Identity,
	identity,
	type SpanCheck
} from "#compiler/core/identity.ts"
import { type ConstraintName, ExprId, type LawId, NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings } from "#compiler/core/order.ts"
import type * as Result from "#compiler/core/result.ts"
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
import type { TheoryRelation } from "#compiler/ir/law.ts"
import type { PhysicalReason } from "#compiler/ir/products.ts"
import { baseOf, contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import type { ConstraintLaw } from "#compiler/laws/model/model.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { noTextDomainUses } from "#compiler/physical/ddl/domains.ts"
import { lowerPersistent } from "#compiler/physical/ddl/expr.ts"
import {
	type InstallContribution,
	type InstallExtension,
	noContribution
} from "#compiler/physical/install/extension.ts"
import { enforcement, lawReasons } from "#compiler/physical/obligations/graph.ts"
import { definedRangeOp } from "#compiler/scalar/compute/registry.ts"
import type { Expr, TableConstraint } from "#compiler/sql/ast.ts"
import { and, binary, call, cast, eq, lit, not, tableCol, types } from "#compiler/sql/build.ts"

/** One CHECK of one span column, with the reasons its physical object carries: its shape, its fixed width, or an
 * endpoint CHECK, which substitutes the predicate of a contract along the endpoint's chain. */
type SpanConstraint = {
	readonly relation: StoredRelation
	readonly field: string
	readonly named: Identity<"spanCheck">
	readonly constraint: TableConstraint & { readonly kind: "check"; readonly name: ConstraintName }
	readonly reasons: ReadonlyArray<PhysicalReason>
} & (
	| { readonly kind: "shape" | "width" }
	| {
			readonly kind: "endpoint"
			readonly contract: DeclaredName
			/** The laws a violation reports: the contract's own. */
			readonly laws: ReadonlyArray<LawId>
	  }
)

type StoredRelation = Extract<TheoryRelation, { readonly kind: "relation" }>

/** A span column type's range carrier, its endpoint, and its fixed width when it has one. */
interface SpanColumnInfo {
	readonly carrier: "range4" | "range8"
	readonly endpoint: ScalarType
	readonly width: bigint | undefined
}

/** The span information of a column type, or undefined when the column is no span. */
const spanColumnInfo = (t: ScalarType): SpanColumnInfo | undefined => {
	const b = baseOf(t)
	if (b.carrier !== "range4" && b.carrier !== "range8") {
		return undefined
	}
	return { carrier: b.carrier, endpoint: b.span.endpoint, width: b.span.width }
}

/** The span shape over the column: nonempty, bounded on both sides, lower bound inclusive and upper bound exclusive. */
const spanShapePredicate = (column: string): Expr => {
	const c = tableCol(column)
	return and([
		not(call("isempty", [c])),
		not(call("lower_inf", [c])),
		not(call("upper_inf", [c])),
		call("lower_inc", [c]),
		not(call("upper_inc", [c]))
	])
}

/** The fixed width over the column: upper(c)::numeric - lower(c)::numeric = <width>. */
const spanWidthPredicate = (column: string, width: bigint): Expr => {
	const c = tableCol(column)
	return eq(
		binary("-", cast(call("upper", [c]), types.numeric), cast(call("lower", [c]), types.numeric)),
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
			loc: SourceLoc(
				`the ${bound} endpoint check of ${relation}.${field} over contract ${contract.name}`,
				[]
			)
		})
	}
	return and([side("lower"), side("upper")])
}

/** The laws of a contract: those its domain's native object enforces. */
const contractLaws = (b: InstallBuilder, contract: DeclaredName): ReadonlyArray<LawId> =>
	b.natives.flatMap(({ object }) =>
		object.kind === "Domain" && object.name === contract ? object.lawIds : []
	)

/** One of a span column's CHECKs, its name minted at the naming door. */
const spanCheck = (
	b: InstallBuilder,
	relation: string,
	field: string,
	check: SpanCheck,
	predicate: Expr
): Pick<SpanConstraint, "named" | "constraint"> => {
	const named = identity.spanCheck(relation, field, check)
	return { named, constraint: { kind: "check", name: b.name(named), predicate } }
}

/** The span CHECKs of one stored relation, in field order: per span column its shape, its width, then one endpoint
 * CHECK per contract with a predicate. Throws a Refusal, which the installer's boundary turns into a failure. */
const spanColumnConstraints = (
	b: InstallBuilder,
	r: StoredRelation
): ReadonlyArray<SpanConstraint> => {
	const relation = r.name
	const out: Array<SpanConstraint> = []
	for (const c of r.fields) {
		const info = spanColumnInfo(c.type)
		if (info === undefined) {
			continue
		}
		const column = b.names.column(relation, c.name)
		const label = `${relation}.${c.name}`
		out.push({
			relation: r,
			field: c.name,
			kind: "shape",
			...spanCheck(b, relation, c.name, { kind: "shape" }, spanShapePredicate(column)),
			reasons: [enforcement(`span shape of ${label}: nonempty, bounded and half-open`)]
		})
		if (info.width !== undefined) {
			out.push({
				relation: r,
				field: c.name,
				kind: "width",
				...spanCheck(
					b,
					relation,
					c.name,
					{ kind: "width" },
					spanWidthPredicate(column, info.width)
				),
				reasons: [enforcement(`span width ${info.width} of ${label}`)]
			})
		}
		for (const contract of endpointContracts(info.endpoint)) {
			const laws = contractLaws(b, contract.name)
			out.push({
				relation: r,
				field: c.name,
				kind: "endpoint",
				contract: contract.name,
				...spanCheck(
					b,
					relation,
					c.name,
					{ kind: "endpoint", contract: contract.name },
					spanEndpointPredicate(b, relation, c.name, c.type, contract, info.carrier)
				),
				laws,
				reasons:
					laws.length > 0
						? lawReasons(laws)
						: [enforcement(`span endpoints of ${label} in contract ${contract.name}`)]
			})
		}
	}
	return out
}

/** Every stored relation's span CHECKs, in relation name order. */
const spanConstraints = (b: InstallBuilder): ReadonlyArray<SpanConstraint> =>
	Object.values(b.model.theory.relations)
		.flatMap((r) => (r.kind === "relation" ? [r] : []))
		.toSorted((x, y) => compareStrings(x.name, y.name))
		.flatMap((r) => spanColumnConstraints(b, r))

/** Each span CHECK with the law a violation reports, for the constraint-to-law map: an endpoint CHECK reports its
 * contract's law, described as the contract, because the library evaluates no contract predicate; the shape and width
 * CHECKs report none, because a span value's codec refuses an empty, unbounded or reversed span and one whose width
 * differs from the column's fixed width before any SQL is sent (`admitSpan`), and grizzle's own span producers never
 * make one. */
const spanConstraintLaws = (
	constraints: ReadonlyArray<SpanConstraint>
): ReadonlyArray<ConstraintLaw> =>
	constraints.flatMap((c): ReadonlyArray<ConstraintLaw> => {
		if (c.kind !== "endpoint") {
			return []
		}
		const [law] = c.laws
		return law === undefined
			? []
			: [
					{
						kind: "constraint",
						name: c.constraint.name,
						owner: c.relation.ident,
						laws: [{ law, described: contractLaw(c.contract) }]
					}
				]
	})

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
					schema: b.settings.installation,
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

/** Span storage: the CHECKs every span column carries, as the installer's built-in contribution.
 *
 * A span is one base range column, int4range over an integer endpoint and int8range over a bigint one, NOT NULL like
 * every column. The table never stores two public endpoint columns. Beside the column, every writer meets these native
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
 * own physical objects in Structure, after their table. `compileInstallation` runs this extension before any caller
 * extension, so no installation path can leave them out. */
export const spanStorage: InstallExtension = {
	contribute: (b): Result.Result<InstallContribution, CompileError> =>
		catchRefusal(() => {
			const constraints = spanConstraints(b)
			addSpanChecks(b, constraints)
			return { ...noContribution, constraintLaws: spanConstraintLaws(constraints) }
		}),
	textDomainUses: noTextDomainUses
}
