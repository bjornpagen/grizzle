import { oneOf, type RowDecoder } from "#compiler/core/decoder.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { parseNameCharacters } from "#compiler/core/identity.ts"
import { childLoc } from "#compiler/core/loc.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { isList } from "#compiler/core/record.ts"
import {
	decodeDesc,
	type FieldDesc,
	type OrderDesc,
	type QueryDesc,
	type QueryStageDesc,
	type TakeDesc
} from "#compiler/ir/desc.ts"
import type { BuilderScope, OpenBound, OpenExpr, VarScope } from "#compiler/ir/open.ts"

import {
	attachedDecoders,
	attachmentName,
	checkDelivery,
	parentVars,
	runAttach
} from "#compiler/query/build/attach.ts"

import {
	fieldsHeading,
	type Heading,
	headingField,
	schemaInfo,
	unionHeading,
	withAttachment
} from "#compiler/query/build/heading.ts"
import { hostArguments } from "#compiler/query/build/host.ts"
import { type RuleRun, runRule } from "#compiler/query/build/rule.ts"
import {
	buildLoc,
	isCallback,
	isObjectRecord,
	mintSite,
	noOrigin,
	type SchemaInfo
} from "#compiler/query/build/scope.ts"

import {
	type DescribedOnly,
	described,
	headingOf,
	isOrdered,
	publicDesc,
	type QueryCarriers,
	type QueryState,
	queryState,
	refusedRows,
	registeredSource,
	registerQuery,
	registerSource,
	type SourceInfo,
	sourceInfo
} from "#compiler/query/build/state.ts"

import {
	fieldTerm,
	headValueOf,
	type UntypedTerm,
	untypedTerm
} from "#compiler/query/build/terms.ts"
import { predicateExpr, termExpr } from "#compiler/scalar/compute/term.ts"
import type { SqlTag } from "#compiler/scalar/registry.ts"
import { levelOf } from "#compiler/schema/level.ts"
import { untypedLiteral } from "#compiler/schema/literal.ts"
import {
	fieldDescOf,
	isPlainRecord,
	malformed,
	orThrow,
	ownedKind,
	registerQuerySchema,
	requireName
} from "#compiler/schema/protocol.ts"

import {
	mint,
	record,
	sameHeadingRecord,
	carrierUnion as unionCarriers
} from "#compiler/schema/record.ts"
import type { Carrier, Carriers, Term } from "#compiler/types/core/phantom.ts"
import type { Evidence } from "#compiler/types/evidence/evidence.ts"
import type { FieldBase } from "#compiler/types/fields/field.ts"
import type {
	BoundSource,
	Decoders,
	Ordered,
	Query,
	QueryBuilder,
	QueryConstructor,
	ScopeName,
	SelfSource,
	UnionArms,
	VConstructor
} from "#compiler/types/query/query.ts"
import type { Rule } from "#compiler/types/query/rule.ts"
import type { VarOrigins, VSource } from "#compiler/types/query/terms.ts"

/**
 * The values are built under their public types (types/query): queryOf, orderedOf and builderOf
 * below implement Query, Ordered and QueryBuilder, each method under its contextual signature, and every value holds
 * the brand (core/phantom.ts) and its heading of carriers. The heading as a host type, evidence, parameters and schema
 * those types carry are phantoms no runtime value holds, so a value built from a state has the type the method that
 * built it gives it.
 *
 * What a JavaScript caller sees: a value of any query, ordered query or builder, each method taking what such a caller
 * may pass. It is a view of the typed values, never a second builder: every typed value is one, since
 * its methods are declared with method syntax, and queryOver and the predicates below deliver the typed
 * values themselves under it. The internal tests and packages that drive the builder over values known only at run
 * time read them through it.
 */
export interface QueryValue extends Built, Decoders<unknown, unknown> {
	readonly heading: Carriers
	rule(rule: unknown): QueryValue
	attach(name: unknown, child: unknown, delivery: unknown): QueryValue
	named(name: unknown): QueryValue
	bind(bindings: unknown): Built
	orderBy(...order: ReadonlyArray<unknown>): OrderedValue
	approximateNearest(spec: unknown): QueryValue
}

export interface OrderedValue extends Built, Decoders<unknown, unknown> {
	take(k: unknown): QueryValue
}

interface QueryBuilderValue {
	rule(rule: unknown): QueryValue
	recursive(name: unknown, spec: unknown): QueryValue
}

/** The runtime member a query value has beside its public ones: the schema value it was built over. */
interface SchemaMember {
	readonly schema: unknown
}

const decodeStage = (stage: QueryStageDesc): QueryDesc => orThrow(decodeDesc("query", { stage }))

/**
 * One heading group of a query's records: the arms that deliver one heading, the keys of its decoders' records, which
 * reach the reader through one statement whose rows no binding tells apart. A group of plain arms (no attachment, every
 * head term carrying its column) decodes as one record over the union of their carriers, each cell read by the type
 * the checker gives its column in every arm (schema/record.ts sameHeadingRecord, core/decoder.ts unionColumn). Any
 * other group (an attached query or arm) decodes by its own decoders. No two groups of a query share a heading
 * (unionRecords), so oneOf binds every layout to the one group whose heading it delivers.
 */
type HeadingGroup<Head, IHead> =
	| {
			readonly kind: "carried"
			readonly carriers: Carriers
			readonly decoders: Decoders<Head, IHead>
	  }
	| { readonly kind: "decoded"; readonly decoders: Decoders<Head, IHead> }
type HeadingGroups<Head, IHead> = NonEmptyReadonlyArray<HeadingGroup<Head, IHead>>

/**
 * What a query's records decode by: its heading groups, or `described` when an arm or source of it is described. Such
 * a query delivers no records, whatever its other arms decode: a described arm's rows would otherwise be read by the
 * decoders of a group whose heading their layout delivers (oneOf binds by keys alone).
 */
type QueryRecords<Head, IHead> =
	| { readonly kind: "grouped"; readonly groups: HeadingGroups<Head, IHead> }
	| DescribedOnly

const grouped = <Head, IHead>(groups: HeadingGroups<Head, IHead>): QueryRecords<Head, IHead> => ({
	kind: "grouped",
	groups
})

/**
 * A query's decoders: its groups' decoders combined by oneOf, which picks a layout's group by its keys; a described
 * query's refuse every layout (state.ts refusedRows).
 */
const decodersOf = <Head, IHead>(records: QueryRecords<Head, IHead>): Decoders<Head, IHead> => {
	if (records.kind === "described") {
		return { rows: refusedRows(), immediate: refusedRows() }
	}
	const [first, ...rest] = records.groups
	return rest.reduce<Decoders<Head, IHead>>(
		(d, g) => ({
			rows: oneOf(d.rows, g.decoders.rows),
			immediate: oneOf(d.immediate, g.decoders.immediate)
		}),
		first.decoders
	)
}

/**
 * One arm's heading group: carried when the arm is plain, decoded by its own decoders when it attaches; a described arm
 * is `described`, which makes every union holding it described (unionRecords).
 */
const armGroup = <Head, IHead>(
	arm: RuleRun<Decoders<Head, IHead>>
): HeadingGroup<Head, IHead> | DescribedOnly => {
	const { carriers, rule } = arm.state
	if (carriers.kind === "described") {
		return described
	}
	if (rule.attach.length > 0) {
		return { kind: "decoded", decoders: arm.finished }
	}
	return { kind: "carried", carriers: carriers.carriers, decoders: arm.finished }
}

/** Whether two groups' decoders share a heading: a key set both deliver records of, in rows or in an immediate read. */
const sharesHeading = (a: Decoders<unknown, unknown>, b: Decoders<unknown, unknown>): boolean => {
	const same = (x: ReadonlyArray<string>, y: ReadonlyArray<string>): boolean =>
		x.length === y.length && x.every((key) => y.includes(key))
	const shared = (x: RowDecoder<unknown>, y: RowDecoder<unknown>): boolean =>
		x.headings.some((h) => y.headings.some((k) => same(h, k)))
	return shared(a.rows, b.rows) || shared(a.immediate, b.immediate)
}

/**
 * The records of a union, a group per heading: an arm whose heading no group delivers is a group of its own, and a
 * carried arm joins the carried group of its heading, as one record over both groups' carriers. An arm of a heading
 * another group delivers, where either attaches, is refused: their rows reach the reader through one statement and no
 * record could tell them apart. A described side makes the union described.
 */
const unionRecords = <H1, I1, H2, I2>(
	records: QueryRecords<H1, I1>,
	arm: HeadingGroup<H2, I2> | DescribedOnly
): QueryRecords<H1 | H2, I1 | I2> => {
	if (records.kind === "described" || arm.kind === "described") {
		return described
	}
	const at = records.groups.findIndex((g) => sharesHeading(g.decoders, arm.decoders))
	if (at < 0) {
		return grouped<H1 | H2, I1 | I2>([...records.groups, arm])
	}
	return grouped(
		mapNonEmpty(records.groups, (g, i): HeadingGroup<H1 | H2, I1 | I2> => {
			if (i !== at) {
				return g
			}
			if (g.kind !== "carried" || arm.kind !== "carried") {
				throw malformed(
					"union",
					"an arm whose heading no other arm delivers, unless both are plain arms: arms of one heading reach the reader through one statement, and only plain arms decode as one record"
				)
			}
			const carriers = unionCarriers(g.carriers, arm.carriers)
			return {
				kind: "carried",
				carriers,
				decoders: {
					rows: sameHeadingRecord<H1, H2>(carriers),
					immediate: sameHeadingRecord<I1, I2>(carriers)
				}
			}
		})
	)
}

/**
 * The state of a stage the builder made: its Description, decoded through the Description shapes, and the attachment
 * children whose parent variables its top-level rules spell.
 */
const makeState = <C extends Carriers>(
	schema: SchemaInfo,
	stage: QueryStageDesc,
	pending: ReadonlySet<BuilderScope>,
	heading: Heading,
	carriers: QueryCarriers<C>
): QueryState<C> => ({ desc: decodeStage(stage), heading, carriers, schema, pending })

/** The attachment children either side's top-level rules spell parent variables of. */
const bothPending = (
	a: ReadonlySet<BuilderScope>,
	b: ReadonlySet<BuilderScope>
): ReadonlySet<BuilderScope> => new Set([...a, ...b])

const defineDesc = <T extends object>(value: T, state: QueryState, label: string): T => {
	Object.defineProperty(value, "desc", {
		get: () => publicDesc(state, label),
		enumerable: false,
		configurable: false
	})
	const schema = state.schema.value
	if (typeof schema === "object" && schema !== null) {
		registerQuerySchema(value, schema)
	}
	return Object.freeze(registerQuery(value, state))
}

/**
 * A query value over a state and its records, implementing Query<S, Head, Ev, P, IHead, Hc, Cx, Arms>; each
 * combinator's result type is the one its signature names, its heading of carriers the state's (headingOf), and its
 * records the ones it builds. The contexts it reads, Cx, and its arms, Arms, are phantoms.
 */
export const queryOf = <
	S,
	Head,
	Ev extends Evidence,
	P,
	IHead,
	Hc extends Carriers,
	Cx,
	Arms extends UnionArms
>(
	state: QueryState<Hc>,
	records: QueryRecords<Head, IHead>
): Query<S, Head, Ev, P, IHead, Hc, Cx, Arms> => {
	const { schema, heading, pending } = state
	const carriers = headingOf(state.carriers)
	const decoders = decodersOf(records)
	const stage = state.desc.stage
	const next = <H2, E2 extends Evidence, P2, I2, C2 extends Carriers, X2, A2 extends UnionArms>(
		s: QueryStageDesc,
		p: ReadonlySet<BuilderScope>,
		h: Heading,
		c: QueryCarriers<C2>,
		r: QueryRecords<H2, I2>
	): Query<S, H2, E2, P2, I2, C2, X2, A2> => queryOf(makeState(schema, s, p, h, c), r)
	const value: Query<S, Head, Ev, P, IHead, Hc, Cx, Arms> & SchemaMember = {
		...builtMark,
		schema: schema.value,
		heading: carriers,
		rows: decoders.rows,
		immediate: decoders.immediate,
		/**
		 * An additional arm: appended to the builder's rules, otherwise a union beside this query. Its heading of
		 * carriers is the arms', and its records decode by heading group (unionRecords).
		 * It is typed unless both sides are described: a described side's heading carries no key, so the other side's
		 * carriers are the union's for its keys.
		 */
		rule: (rule) => {
			const label = "Query.rule"
			hostArguments(label, [rule])
			const loc = buildLoc(label, [])
			const arm = runRule(schema, rule, "rule", undefined)
			const h = unionHeading([heading, arm.state.heading])
			const c = unionCarriers(carriers, arm.finished.heading)
			const qc: QueryCarriers<typeof c> =
				state.carriers.kind === "described" && arm.state.carriers.kind === "described"
					? described
					: { kind: "typed", carriers: c }
			const r = unionRecords(records, armGroup(arm))
			const p = bothPending(pending, arm.state.pending)
			if (stage.kind === "rules" || stage.kind === "union") {
				return next({ ...stage, arms: [...stage.arms, arm.state.rule] }, p, h, qc, r)
			}
			return next({ kind: "union", input: stage, arms: [arm.state.rule], loc }, p, h, qc, r)
		},
		/**
		 * The parent variables are minted over the query's carriers, and the decoders are built from the stated
		 * delivery (attach.ts attachedDecoders).
		 */
		attach: (name, child, delivery) => {
			const label = `Query.attach(${typeof name === "string" ? name : "?"})`
			hostArguments(label, [name, child, delivery])
			const n = attachmentName(name, heading, label)
			if (!isCallback(child)) {
				throw malformed(
					label,
					"an attachment child, (parent) => query(S).rule(...), a query over the parent's variables"
				)
			}
			checkDelivery(delivery, heading, label)
			const attached = runAttach(
				n,
				(scope) => child(parentVars(scope, heading, carriers)),
				label,
				state.schema.over
			)
			return next(
				{ kind: "attach", input: stage, attach: attached.desc },
				pending,
				withAttachment(heading, n),
				state.carriers,
				records.kind === "described"
					? records
					: grouped([
							{
								kind: "decoded",
								decoders: attachedDecoders(decoders, name, attached.child, delivery)
							}
						])
			)
		},
		named: (name) => {
			hostArguments("Query.named", [name])
			const n = requireName(name, "Query.named", "a diagnostic name")
			return next(
				{ kind: "named", input: stage, name: n, loc: buildLoc("Query.named", [n]) },
				pending,
				heading,
				state.carriers,
				records
			)
		},
		bind: (bindings) => {
			hostArguments("Query.bind", [bindings])
			return bindQuery(state, bindings)
		},
		orderBy: (...order) => {
			hostArguments("Query.orderBy", order)
			return orderedOf(
				makeState(schema, orderStage(stage, heading, order), pending, heading, state.carriers),
				records
			)
		},
		/**
		 * A sealed candidate source over the cosineDistance output `by`; that `by` names one is the
		 * checker's.
		 */
		approximateNearest: (spec) => {
			hostArguments("Query.approximateNearest", [spec])
			return next(approximateStage(stage, heading, spec), pending, heading, state.carriers, records)
		}
	}
	return defineDesc(value, state, "query")
}

const approximateStage = (
	stage: QueryStageDesc,
	heading: Heading,
	spec: unknown
): QueryStageDesc => {
	const label = "Query.approximateNearest"
	if (!isPlainRecord(spec) || Object.keys(spec).some((k) => k !== "by" && k !== "take")) {
		throw malformed(
			label,
			"a spec { by, take }: the distance column and the requested result bound"
		)
	}
	const by = requireName(spec["by"], label, "by, the distance column")
	if (!heading.fields.has(by)) {
		throw malformed(
			label,
			`by naming a column of the query's heading; ${JSON.stringify(by)} is not one`
		)
	}
	const take = positiveInteger(spec["take"], label, "take, the requested result bound")
	return { kind: "approx", input: stage, by, take, loc: buildLoc(label, [by]) }
}

const positiveInteger = (value: unknown, label: string, what: string): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw malformed(label, `${what}: a positive integer`)
	}
	return value
}

/**
 * orderBy: fields of the final heading, each ascending or descending, each at most once. Over a union
 * the checker requires each to be common to every arm, the discriminant completing ties.
 */
const orderStage = (
	stage: QueryStageDesc,
	heading: Heading,
	order: ReadonlyArray<unknown>
): QueryStageDesc => {
	const label = "Query.orderBy"
	if (order.length === 0) {
		throw malformed(
			label,
			"at least one [field, direction] pair: the compiler completes the order with a key"
		)
	}
	const out: Array<OrderDesc> = []
	const seen = new Set<string>()
	for (const pair of order) {
		if (!isList(pair) || pair.length !== 2) {
			throw malformed(label, `[field, "asc" | "desc"] pairs, such as ["budget", "desc"]`)
		}
		const [column, dir] = pair
		const name = requireName(column, label, "an order field")
		if (!heading.fields.has(name)) {
			throw malformed(label, `fields of the result heading; ${JSON.stringify(name)} is not one`)
		}
		if (dir !== "asc" && dir !== "desc") {
			throw malformed(label, `a direction "asc" or "desc" for ${name}`)
		}
		if (seen.has(name)) {
			throw malformed(label, `each field at most once; ${name} repeats`)
		}
		seen.add(name)
		out.push({ column: name, dir })
	}
	return { kind: "order", input: stage, order: out, loc: buildLoc(label, []) }
}

/** An ordered value over a state and its records, implementing Ordered<S, Head, Ev, P, IHead, Hc, Cx, Arms>. */
export const orderedOf = <
	S,
	Head,
	Ev extends Evidence,
	P,
	IHead,
	Hc extends Carriers,
	Cx,
	Arms extends UnionArms
>(
	state: QueryState<Hc>,
	records: QueryRecords<Head, IHead>
): Ordered<S, Head, Ev, P, IHead, Hc, Cx, Arms> => {
	const stage = state.desc.stage
	const decoders = decodersOf(records)
	const value: Ordered<S, Head, Ev, P, IHead, Hc, Cx, Arms> & SchemaMember = {
		...builtMark,
		schema: state.schema.value,
		heading: headingOf(state.carriers),
		rows: decoders.rows,
		immediate: decoders.immediate,
		/** The first k under the completed total order, a set again. */
		take: (k) => {
			hostArguments("Ordered.take", [k])
			return queryOf(
				makeState(
					state.schema,
					{ kind: "take", input: stage, take: takeOf(k), loc: buildLoc("Ordered.take", []) },
					state.pending,
					state.heading,
					state.carriers
				),
				records
			)
		}
	}
	return defineDesc(value, state, "ordered query")
}

/** take(k): a positive literal, or the name of an integer parameter. */
const takeOf = (k: unknown): TakeDesc => {
	const label = "Ordered.take"
	return typeof k === "string"
		? { kind: "param", name: requireName(k, label, "an integer parameter name") }
		: { kind: "literal", k: positiveInteger(k, label, "k, a positive literal or a parameter name") }
}

/**
 * Query.bind: each required input of the imported query bound to a term, an outer
 * parameter or a literal. A relation parameter is bound to a relation parameter of the importing rule; a source of
 * any other kind has no binding form in the Description.
 */
const bindQuery = <S, Head, SP, Hc extends Carriers, Cx, Ev, Rd>(
	state: QueryState<Hc>,
	bindings: unknown
): BoundSource<S, Head, SP, Hc, Cx, Ev, Rd> => {
	const label = "Query.bind"
	if (!isPlainRecord(bindings)) {
		throw malformed(
			label,
			"bindings: a record from the query's parameter names to terms, parameters or literals"
		)
	}
	const out: Record<string, OpenBound> = {}
	for (const [name, value] of Object.entries(bindings)) {
		requireName(name, label, "a parameter name")
		if (value === undefined) {
			throw malformed(label, `a binding for ${name}`)
		}
		const expr = termExpr(value)
		if (expr !== undefined) {
			out[name] = expr
		} else if (predicateExpr(value) !== undefined || headValueOf(value) !== undefined) {
			throw malformed(
				label,
				`a term, a parameter or a literal for ${name}, not a predicate or head term`
			)
		} else {
			const source = boundSource(value)
			out[name] = source ?? {
				kind: "literal",
				value: untypedLiteral(value, `${label} ${name}`),
				type: undefined
			}
		}
	}
	const desc = publicDesc(state, label)
	const carriers = headingOf(state.carriers)
	return registerSource(Object.freeze({ ...builtMark, heading: carriers }), {
		desc: { kind: "query", query: desc, bind: out },
		heading: state.heading,
		carriers,
		origin: noOrigin,
		scope: { kind: "written", over: state.schema.over },
		label: "bound query"
	})
}

/** A relation parameter bound to a relation parameter of the importing rule: the outer parameter, by name. */
const boundSource = (value: unknown): OpenBound | undefined => {
	const registered = registeredSource(value)
	if (
		registered !== undefined &&
		(registered.desc.kind === "param" || registered.desc.kind === "paramOf")
	) {
		return { kind: "relationParam", name: registered.desc.name }
	}
	const isRelation =
		typeof value === "object" &&
		value !== null &&
		(ownedKind(value) !== undefined || (isObjectRecord(value) && value["kind"] === "relation"))
	if (registered !== undefined || queryState(value) !== undefined || isRelation) {
		throw unsupported(
			buildLoc("Query.bind", []),
			"bindRelationParameter: a relation parameter of an imported query is bound to a relation parameter of the importing rule, r.relation(name, heading); a query or relation source has no binding form in the Description"
		)
	}
	return undefined
}

/**
 * The schema query(S) is over: a schema value schema(...) or schema.extend(...) built, or a role value role(...)
 * built, refusing anything else and a JavaScript caller's extra argument.
 */
const querySchema = (schema: unknown, extra: ReadonlyArray<unknown>): SchemaInfo => {
	hostArguments("query", [schema, ...extra])
	if (extra.length > 0) {
		throw malformed("query", "query(schema): one argument")
	}
	const level = levelOf(schema)
	if (level === undefined) {
		throw malformed(
			"query",
			"a schema built by schema(...) or schema.extend(...), or a role built by role(...)"
		)
	}
	return schemaInfo(schema, level)
}

/**
 * query(S), v, and the query values.
 *
 * A query value is the chain of combinators that built it, recorded as a QueryDesc whose stages are in application
 * order (ir/desc.ts QueryStageDesc), so a Description rebuilds the same query:
 *
 * - query(S).rule(a).rule(b) is one rules stage with arms a and b; query(S).recursive(name, { row, base, rec }) is a
 *   recursive stage;
 * - Query.rule on any other query is a union stage: its arms beside that query's rows, whatever their heading, a
 *   heterogeneous union the checker requires a discriminant for; consecutive rule calls append arms. Its records decode
 *   by heading group (HeadingGroup): plain arms of one heading as one record over their carriers, so each constant arm
 *   reads its own literal, an attached arm of one heading no other arm delivers, and the groups by oneOf;
 * - attach, named and approximateNearest are their own stages; orderBy makes an Ordered, whose only combinator is
 *   take, which makes a Query again. take(k) is a positive literal or the name of an integer
 *   parameter.
 *
 * `bind` closes an imported query's parameters with terms, outer parameters or literals, hygienically: each binding is
 * recorded on the match source that imports it. A relation parameter of the imported query
 * is bound to a relation parameter of the importing rule. Every stage is decoded through the Description shapes as it
 * is built, so a value the builder makes always holds an owned, valid Description, exposed as its non-enumerable
 * `desc` for the packages that compile, store or describe it.
 *
 * query(S), the public builder: QueryBuilder<S> over the schema.
 */
export const query: QueryConstructor = (schema, ...extra: ReadonlyArray<unknown>) =>
	builderOf(querySchema(schema, extra))

/** query(S) for a JavaScript caller, whose schema is known only at run time: the same builder, under the view. */
export const queryOver = (schema: unknown, ...extra: ReadonlyArray<unknown>): QueryBuilderValue =>
	builderOf(querySchema(schema, extra))

/** The builder over a schema, implementing QueryBuilder<S>. */
const builderOf = <S>(info: SchemaInfo): QueryBuilder<S> => {
	const builder: QueryBuilder<S> = {
		/** A query of one arm: its carriers, heading group and decoders the arm's. */
		rule: (rule) => {
			hostArguments("query.rule", [rule])
			const loc = buildLoc("query.rule", [])
			const arm = runRule(info, rule, "rule", undefined)
			const group = armGroup(arm)
			return queryOf(
				makeState(
					info,
					{ kind: "rules", arms: [arm.state.rule], loc },
					arm.state.pending,
					arm.state.heading,
					group.kind === "described" ? described : { kind: "typed", carriers: arm.finished.heading }
				),
				group.kind === "described" ? described : grouped([group])
			)
		},
		/**
		 * The definition's facts are records of its row (schema/record.ts record), under either reading; recursive has
		 * admitted the row, a record of descriptors, which is its one carried heading group.
		 */
		recursive: (name, spec) => {
			hostArguments("query.recursive", [name, spec])
			const state = recursive(info, name, spec)
			const rows = record(spec.row)
			return queryOf(
				state,
				grouped([{ kind: "carried", carriers: spec.row, decoders: { rows, immediate: rows } }])
			)
		}
	}
	return Object.freeze(builder)
}

/**
 * query(S).recursive(name, { row, base, rec }): an explicit state row, base arms, and recursive arms
 * that receive the definition's self, a source matched only in them. The row is the definition's heading of carriers.
 */
const recursive = <S, const Row extends Record<string, FieldBase>>(
	info: SchemaInfo,
	name: unknown,
	spec: {
		readonly row: Row
		readonly base: ReadonlyArray<(r: Rule<S>) => unknown>
		readonly rec: ReadonlyArray<(r: Rule<S>, self: SelfSource<Row>) => unknown>
	}
): QueryState<Row> => {
	const n = requireName(name, "query.recursive", "a recursive relation name")
	const label = `recursive ${n}`
	const loc = buildLoc(label, [n])
	if (
		!isPlainRecord(spec) ||
		Object.keys(spec).some((k) => k !== "row" && k !== "base" && k !== "rec")
	) {
		throw malformed(label, "a spec { row, base, rec }")
	}
	const { row, base, rec } = spec
	if (!isPlainRecord(row) || Object.keys(row).length === 0) {
		throw malformed(
			label,
			"a row: a nonempty record of field descriptors, the recursive state signature"
		)
	}
	const rowDescs: Record<string, FieldDesc> = {}
	for (const [field, descriptor] of Object.entries(row)) {
		requireName(field, label, "a row field name")
		rowDescs[field] = fieldDescOf(descriptor, `${label} row ${field}`)
	}
	const arms = <A>(value: ReadonlyArray<A>, what: string): NonEmptyReadonlyArray<A> => {
		if (!isList(value) || !isNonEmpty(value)) {
			throw malformed(label, `${what}: a nonempty list of rule callbacks`)
		}
		return value
	}
	const baseArms = arms(base, "base")
	const recArms = arms(rec, "rec")
	const rowHeading = fieldsHeading(rowDescs, row, info.env)
	const token = {}
	const self: SelfSource<Row> = registerSource(Object.freeze({ ...builtMark, heading: row }), {
		desc: { kind: "self" },
		heading: rowHeading,
		carriers: row,
		origin: noOrigin,
		scope: { kind: "self", token },
		label: `self ${n}`
	})
	const baseRuns = mapNonEmpty(
		baseArms,
		(arm) => runRule(info, arm, `${label} base`, undefined).state
	)
	const recRuns = mapNonEmpty(recArms, (arm) => {
		if (!isCallback(arm)) {
			throw malformed(`${label} rec`, "a rule callback, (r, self) => r.match(...).find({ ... })")
		}
		return runRule(info, (r: Rule<S>) => arm(r, self), `${label} rec`, token).state
	})
	return makeState(
		info,
		{
			kind: "recursive",
			recursive: {
				name: n,
				row: rowDescs,
				base: mapNonEmpty(baseRuns, (run) => run.rule),
				rec: mapNonEmpty(recRuns, (run) => run.rule)
			},
			loc
		},
		new Set([...baseRuns, ...recRuns].flatMap((run) => [...run.pending])),
		rowHeading,
		{ kind: "typed", carriers: row }
	)
}

/**
 * What v reads of a source, of the scope name it was given and of the rule it is called in: the source's heading and
 * carriers, and each fresh variable's expression, in the one scope the call makes. The name keeps the declared-name
 * rule's characters (core/identity.ts parseNameCharacters), which its type states (ScopeName), so only a JavaScript
 * caller meets this check, and spells the scope's variables, `<name>.<field>` (rule.ts finishRule), never a SQL
 * identifier. A variable over a relation, closed or derived relation carries that relation and field as its
 * origin. Its fields are typed under the schema of the innermost running rule callback, so v outside every rule
 * callback is refused: no schema would type it. Inside an attachment child but outside its rules, a variable belongs to
 * no rule yet (its owner is "adopted"), and the child's rules adopt it.
 */
const variablesOf = (
	source: unknown,
	name: unknown,
	extra: ReadonlyArray<unknown>
): { readonly info: SourceInfo; readonly expr: (field: string) => OpenExpr } => {
	hostArguments("v", [source, name, ...extra])
	if (extra.length > 0) {
		throw malformed("v", "v(source, name): two arguments")
	}
	if (typeof name !== "string") {
		throw malformed(
			"v",
			"v(source, name): a scope name, the string that names the variables' scope"
		)
	}
	const characters = parseNameCharacters(name)
	if (!characters.ok) {
		throw malformed("v", `the scope name ${JSON.stringify(name)} as ${characters.error}`)
	}
	const site = mintSite()
	if (site === undefined) {
		throw malformed(
			"v",
			"v(source, name) inside a rule callback, whose schema types the variables; outside every callback no schema does"
		)
	}
	const info = sourceInfo(source, "v", site.schema.env)
	const loc = buildLoc(`v(${info.label}, ${JSON.stringify(name)})`, [])
	const scope: VarScope = { name, loc }
	const origin = info.origin
	return {
		info,
		expr: (field) => ({
			kind: "var",
			var: {
				build: site.build,
				owner: site.owner,
				scope,
				field,
				origin: origin.kind === "relation" ? { relation: origin.relation, field } : undefined,
				loc: childLoc(loc, field)
			}
		})
	}
}

/**
 * v(source, name) for a JavaScript caller, the admission core of v: fresh variables over the source's heading in the
 * scope `name`, one per scalar field, each a branded term, carried by the field's carrier, or untyped where the source
 * carries none (a described query, state.ts QueryCarriers, whose carriers are the empty heading).
 */
export const varsOver = (
	source: unknown,
	name: unknown,
	...extra: ReadonlyArray<unknown>
): Readonly<Record<string, UntypedTerm>> => {
	const { info, expr } = variablesOf(source, name, extra)
	const out: Record<string, UntypedTerm> = {}
	for (const [field, typing] of info.heading.fields) {
		const carrier = Object.hasOwn(info.carriers, field) ? info.carriers[field] : undefined
		out[field] =
			carrier === undefined ? untypedTerm(expr(field)) : fieldTerm(expr(field), typing, carrier)
	}
	return Object.freeze(out)
}

/**
 * v(source, name), the public builder: the variables minted over the source's heading of carriers in the scope `name`
 * (schema/record.ts mint), each a term of its carrier's host and SQL type with its origin (VarsOf).
 */
export const v: VConstructor = <R extends VSource, const N extends string>(
	source: R,
	name: ScopeName<N>,
	...extra: ReadonlyArray<unknown>
) => {
	const { info, expr } = variablesOf(source, name, extra)
	return mint<VarOrigins<R, N>, R["heading"]>(
		source.heading,
		<A, S extends SqlTag>(carrier: Carrier<A, S>, field: string): Term<A, unknown, unknown, S> =>
			fieldTerm(expr(field), headingField(info.heading, field, `v(${info.label})`), carrier)
	)
}

export const isQueryValue = (value: unknown): value is QueryValue => {
	const state = queryState(value)
	return state !== undefined && !isOrdered(state)
}

export const isOrderedValue = (value: unknown): value is OrderedValue => {
	const state = queryState(value)
	return state !== undefined && isOrdered(state)
}

/**
 * The Description of a query or ordered value the builder made, refused at `label` while it still holds a pending
 * parent variable.
 */
export const labelledQueryDesc = (value: unknown, label: string): QueryDesc | undefined => {
	const state = queryState(value)
	return state === undefined ? undefined : publicDesc(state, label)
}

export const queryValueDesc = (value: unknown): QueryDesc | undefined =>
	labelledQueryDesc(value, "query")

/** The schema value a query or ordered value the builder made is over. */
export const queryValueSchema = (value: unknown): unknown => queryState(value)?.schema.value
