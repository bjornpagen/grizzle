import type { AdmittedQuery } from "#compiler/check/index.ts"
import { type CompileError, malformedDescription, unsupported } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import type { EvidenceCatalog } from "#compiler/ir/evidence.ts"
import { fieldColumnType, type PhysicalNames } from "#compiler/ir/physical.ts"
import type { Heading, RootedDag } from "#compiler/ir/rel.ts"
import {
	baseOf,
	contractOf,
	numericTypmodOf,
	type ScalarType,
	vectorTypmodOf
} from "#compiler/ir/scalar.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import { lowerOptimized, optimizedInput } from "#compiler/lower/optimize/pipeline.ts"
import { structuralRegex } from "#compiler/physical/ddl/domains.ts"
import { deliveredTypes } from "#compiler/physical/derived/delivered.ts"
import type {
	Collation,
	Expr,
	FromSource,
	OperandBody,
	Select,
	SelectCore,
	SetOperand,
	Target,
	TypeRef
} from "#compiler/sql/ast.ts"
import {
	cast,
	col,
	derived,
	mapTargets,
	provedCore,
	sameTypeRef,
	select,
	target,
	targetAs,
	withArms
} from "#compiler/sql/build.ts"
import { freshNames, type NameMap, NameSupply, namesPast } from "#compiler/sql/naming.ts"

interface DefinitionOptions {
	readonly names: PhysicalNames
	/** The installed key constraints the rewrites may rely on, named as ownership installs them. */
	readonly catalog: EvidenceCatalog
}

export interface LoweredDefinition {
	/** The view's defining SELECT: its output columns, position by position, are `heading`. */
	readonly query: Select
	readonly heading: Heading
	/** The rewrite, placement and shape certificates the optimized lowering recorded. */
	readonly certificates: ReadonlyArray<Certificate>
	/** Every generated name the statement holds, the lowering's and the closing's, so a reader of it mints past them. */
	readonly nameMap: NameMap
}

/** How one output column is closed to its view column: a cast to its column type, then the collation; each
 * undefined when the column needs none. */
interface Closing {
	readonly cast: TypeRef | undefined
	readonly collation: Collation | undefined
}

/** The closing of an output column of type `type` that the statement delivers at `delivered` (deliveredTypes). */
const closingOf = (
	names: PhysicalNames,
	type: ScalarType,
	delivered: TypeRef | undefined
): Closing => {
	const column = fieldColumnType(names, type)
	const retyped =
		contractOf(type) !== undefined || baseOf(type).carrier === "code"
			? delivered === undefined || !sameTypeRef(delivered, column.type)
			: numericTypmodOf(type) !== undefined ||
				vectorTypmodOf(type) !== undefined ||
				structuralRegex(type) !== undefined
	return { cast: retyped ? column.type : undefined, collation: column.collation }
}

const closed = (expr: Expr, closing: Closing | undefined): Expr => {
	if (closing === undefined) {
		return expr
	}
	const typed: Expr = closing.cast === undefined ? expr : cast(expr, closing.cast)
	return closing.collation === undefined
		? typed
		: { kind: "collate", expr: typed, collation: closing.collation }
}

/** The statement with each column closed to its view column. A plain outermost core takes the casts and COLLATEs in its
 * targets; a deduplicating or grouping one is read as a derived table first, so they apply to its deduplicated output
 * rather than to what it compares. */
const withColumnTypes = (
	ast: Select,
	heading: Heading,
	dag: RootedDag,
	names: PhysicalNames,
	nameMap: NameMap,
	relation: string
): Result.Result<{ readonly query: Select; readonly nameMap: NameMap }, CompileError> => {
	const delivered = deliveredTypes(ast, dag, names)
	const closings = heading.map((c, i) => closingOf(names, c.type, delivered(i)))
	if (closings.every((c) => c.cast === undefined && c.collation === undefined)) {
		return Result.ok({ query: ast, nameMap })
	}
	const at = SourceLoc(`derived ${relation}`, [])
	const outer: SelectCore | undefined = ast.body.kind === "core" ? ast.body : undefined
	if (outer === undefined) {
		return Result.err(unsupported(at, "a definition whose outermost body is a SELECT core"))
	}
	if (outer.targets.length !== heading.length) {
		return Result.err(unsupported(at, "a definition with one outermost output per heading column"))
	}
	if (outer.distinct === false && outer.groupBy.length === 0 && outer.having === undefined) {
		const targets: ReadonlyArray<Target> = outer.targets.map((t, i) => ({
			...t,
			expr: closed(t.expr, closings[i])
		}))
		return Result.ok({ query: { ...ast, body: { ...outer, targets } }, nameMap })
	}
	const supply = new NameSupply(namesPast(nameMap, freshNames))
	const origin = { kind: "internal", purpose: "derived view column types" } as const
	const alias = supply.relation(origin)
	/** One generated column per heading column, each closed as its heading column's type needs. */
	const columns = heading.map((c, i) => ({
		name: c.name,
		closing: closings[i],
		column: supply.column(origin)
	}))
	const inner: Select = { ...ast, body: mapTargets(outer, (t) => target(t.expr)) }
	const targets = columns.map((c): Target =>
		targetAs(closed(col(alias, c.column), c.closing), c.name)
	)
	const generated = columns.map((c) => c.column)
	return Result.ok({
		query: select(
			provedCore("keyed", targets, [derived(inner, alias, generated, false)], undefined)
		),
		nameMap: [...nameMap, ...supply.map()]
	})
}

/**
 * A body's outputs left unaliased, every arm of a set operation's alike: a derived table's column list names them, and
 * an EXISTS reads none of them.
 */
export const unaliased = (body: OperandBody): OperandBody => {
	switch (body.kind) {
		case "core":
			return mapTargets(body, (t) => target(t.expr))
		case "select":
			return { ...body, body: unaliased(body.body) }
		case "setOp": {
			const operand = (arm: SetOperand): SetOperand =>
				arm.kind === "core"
					? mapTargets(arm, (t) => target(t.expr))
					: { ...arm, body: unaliased(arm.body) }
			const [first, second, ...rest] = body.arms
			return withArms(body, [operand(first), operand(second), ...rest.map(operand)])
		}
	}
}

/** A lowered definition as a derived table a reader's query reads: the FROM item, and its i-th output's column. */
export interface DerivedReading {
	readonly from: FromSource
	readonly read: (position: number) => Expr
}

/**
 * A lowered definition read as a derived table, so a view can pass its outputs on beside columns it computes from them
 * (a role view's decoded names): the statement under a fresh generated relation alias, its outputs as fresh generated
 * columns, each minted past every name the statement holds (`nameMap`), and its own outputs unaliased. Every alias the
 * reading emits is a generated r<n> or c<n>, as every statement grizzle emits names them. A set operation ordered by
 * its outputs' names, which no definition lowers to, is refused: unaliased outputs would leave its ORDER BY reading
 * nothing.
 */
export const derivedReading = (
	lowered: LoweredDefinition,
	purpose: string
): Result.Result<DerivedReading, CompileError> => {
	const query = lowered.query
	if (query.body.kind !== "core" && query.orderBy.length > 0) {
		return Result.err(
			unsupported(SourceLoc(purpose, []), "a definition read as a derived table, unordered")
		)
	}
	const supply = new NameSupply(namesPast(lowered.nameMap, freshNames))
	const origin = { kind: "internal", purpose } as const
	const alias = supply.relation(origin)
	const generated = lowered.heading.map(() => supply.column(origin))
	return Result.ok({
		from: derived({ ...query, body: unaliased(query.body) }, alias, generated, false),
		read: (position) => col(alias, defined(generated[position], "an output per heading column"))
	})
}

/** The defining SELECT of derived relation `relation`, from its checked definition.
 *
 * The definition is the compiler's ordinary lowering of the query, fully schema-qualified, duplicate-free under the
 * set rule, and producing no NULL: the optimized pipeline over the checked definition, with three settings particular
 * to a stored query:
 *
 * - `derivedDefinition`: a definition always wants every group, so a correlated take takes its whole-relation shape,
 *   DISTINCT ON for one per group and the row_number window otherwise, never a per-parent LATERAL probe, and the
 *   compile-target catalog takes its whole-parent targets. A take correlated through `bind` is
 *   first restated with its correlation explicit, since that is the only way a
 *   correlated take reaches a definition, which admits no attachment;
 * - the `transaction` evidence context: the definition runs inside the refreshing transaction, and also inside an
 *   owner-run migration that repopulates a recreated view, where a deferred constraint may be
 *   temporarily false; so its rewrites rest on descriptor, immediate and query-local evidence only, which holds at
 *   every statement;
 * - a catalog of the schema's declared keys and containments and of every lower level's inherited keys, each the
 *   unique index of its view, so a definition over a lower derived relation relies on that relation's keys like any
 *   base-scan key, and the transaction context admits exactly the containments
 *   enforced at every statement.
 *
 * The program must be one main statement with no placeholder, delivering the definition's heading: a definition reads no
 * parameter and attaches nothing.
 *
 * A view column takes the type, typmod and collation of its defining expression, and the inferred descriptor is what
 * the view must hold, column by column, in the catalog: its column type (ir/physical.ts fieldColumnType), which is also what
 * the installer grants USAGE by. The inferred type is the type the lowering emits, with five exceptions this module
 * closes in the outermost SELECT:
 *
 * - a contract: the lowering delivers a contract value at its domain where it reads it from a column of the domain
 *   or an aggregate lowering casts it there, and at the base type elsewhere: every arm of a set operation casts a
 *   refined column to its base (union/arms.ts), and a literal or a recursive state is base-typed. Every contract column
 *   the statement does not deliver at its domain (delivered.ts deliveredTypes) is cast to the domain; the cast changes
 *   no value, because the checker proved the contract;
 * - a closed id: the lowering delivers a code at its roster domain where it reads it from a column of the domain, and
 *   as a smallint elsewhere: a code literal is base-typed (ir/physical.ts baseTypeRef), so a closed relation's facts,
 *   a VALUES source of code literals, deliver smallint. Every closed id column the statement does not deliver at its
 *   roster domain is cast to the domain; the cast changes no value, because every code a literal holds is a live
 *   handle's under the installation's codebook;
 * - a typmod: PostgreSQL's MIN and MAX return their input type without its typmod, so `min` of a numeric(10, 2) field
 *   is a numeric column of no typmod, while the value, an input unchanged, is the field's. Every column whose
 *   inferred type carries a typmod (a numeric precision and scale, a vector's dimensions) and no contract is cast to
 *   that type; the cast changes no value;
 * - a pattern: a literal is typed by its base type, so a literal of refined text, or any refined text value
 *   the lowering does not read from a domain-typed column, is plain `text`. Every column whose inferred type carries a
 *   structural pattern is cast to that pattern's `__text_` domain, which the installer plans for every pattern a view
 *   column carries (`textColumnUses`). The cast changes no value, because the checker proved the pattern, and
 *   the domain is collated `pg_catalog.pg_c_utf8`;
 * - a collation: a text literal or a computed text value carries the database's default collation, so every
 *   builtin-text column is collated `pg_catalog.pg_c_utf8` explicitly, the closed constant every collatable column
 *   names. */
export const lowerDefinition = (
	relation: string,
	query: AdmittedQuery,
	options: DefinitionOptions
): Result.Result<LoweredDefinition, CompileError> => {
	const at = SourceLoc(`derived ${relation}`, [])
	if (query.params.length > 0) {
		return Result.err(malformedDescription(at, "a parameterless definition"))
	}
	/** The definition as the optimized lowering takes it (optimizedInput), annotated again under the same key evidence. */
	const annotated = optimizedInput(query, queryEvidence)
	if (!annotated.ok) {
		return annotated
	}
	const lowered = lowerOptimized(annotated.value, {
		names: options.names,
		subject: { kind: "derivedDefinition" },
		context: "transaction",
		catalog: options.catalog
	})
	if (!lowered.ok) {
		return lowered
	}
	const optimized = lowered.value
	const parts = optimized.parts
	if (
		parts.kind !== "one" ||
		parts.delivered.role.kind !== "main" ||
		parts.delivered.params.length > 0 ||
		parts.delivered.heading.length === 0 ||
		parts.delivered.fused.length > 0 ||
		optimized.delivery.kind !== "rows" ||
		optimized.statement.forms.kind !== "one"
	) {
		return Result.err(
			unsupported(at, "a definition that lowers to one main statement with no placeholder")
		)
	}
	const main = parts.delivered
	const expected = query.dag.roots[0].heading.map((c) => c.name)
	if (
		main.heading.length !== expected.length ||
		main.heading.some((c, i) => c.name !== expected[i])
	) {
		return Result.err(unsupported(at, "a lowered definition delivering the definition's heading"))
	}
	return Result.map(
		withColumnTypes(main.ast, main.heading, query.dag, options.names, main.sql.nameMap, relation),
		(typed) => ({
			query: typed.query,
			heading: main.heading,
			certificates: optimized.certificates,
			nameMap: typed.nameMap
		})
	)
}
