import { isNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import { codeColumn, type DecoderForm, decoderOf, type RowDecoder } from "#compiler/core/decoder.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { type Built, builtMark } from "#compiler/core/phantom.ts"
import { hasProperties, isPlainRecord } from "#compiler/core/record.ts"
import type { FieldDesc, QueryDesc, QueryStageDesc } from "#compiler/ir/desc.ts"
import type { BuilderScope, OpenRows, OpenSource } from "#compiler/ir/open.ts"
import { Roster } from "#compiler/ir/scalar.ts"
import {
	fieldsHeading,
	fieldTyping,
	type Heading,
	heading,
	unionHeading,
	withAttachment
} from "#compiler/query/build/heading.ts"

import {
	noOrigin,
	type RuleContext,
	relationOrigin,
	type SchemaInfo,
	type SourceOrigin
} from "#compiler/query/build/scope.ts"
import { untyped } from "#compiler/scalar/compute/term.ts"
import { describeField, type ScalarEnv } from "#compiler/scalar/registry.ts"
import { highestLevel, type Level } from "#compiler/schema/level.ts"
import {
	describedDesc as fieldDesc,
	type HeadingTyping,
	malformed,
	type OwnedKind,
	ownedKind,
	ownQuery,
	queryDescOf
} from "#compiler/schema/protocol.ts"
import { emptyHeading } from "#compiler/schema/record.ts"
import { derivedDraftOf, namedRelation, relationDescOf } from "#compiler/schema/relation.ts"
import { contextDescOf, worldDraftOf } from "#compiler/schema/world.ts"
import type { Carrier, Carriers, Headed } from "#compiler/types/core/phantom.ts"
import type { AttachmentDelivery } from "#compiler/types/query/query.ts"

/**
 * A described arm or query: some head term or source of it has no column (a source rebuilt from its Description
 * alone), so its rows have no columns to decode them by.
 */
export interface DescribedOnly {
	readonly kind: "described"
}
export const described: DescribedOnly = Object.freeze({ kind: "described" })

/**
 * A query's or arm's carriers: the typed record of its heading's columns, or `described`: such a query delivers no
 * records, and v over it mints untyped terms.
 */
export type QueryCarriers<C extends Carriers = Carriers> =
	| { readonly kind: "typed"; readonly carriers: C }
	| DescribedOnly

/**
 * The public heading of a query, ordered query or arm with carriers `c`: its typed record, or for a described one the
 * empty heading (schema/record.ts emptyHeading), which every union heading reads as carrying no key.
 */
export const headingOf = <C extends Carriers>(c: QueryCarriers<C>): C =>
	c.kind === "typed" ? c.carriers : emptyHeading<C>()

/** Whether a query is an Ordered (orderBy without take) rather than a Query: its last stage orders. */
export const isOrdered = (state: QueryState): boolean => state.desc.stage.kind === "order"

/**
 * What the builder keeps beside each value it makes: a query's or ordered query's Description, heading and heading of
 * carriers, and what a source contributes to a match.
 *
 * A source's carriers are the columns and SQL types of its heading's fields, which v mints its variables over and an
 * attachment its parent variables: a relation's descriptors, a closed relation's id handle column beside its payload
 * descriptors, a query's head, a relation parameter's fields. A described query (QueryCarriers), such as one rebuilt
 * from its Description alone, has none, and its fields are untyped terms.
 *
 * Query values, ordered values, bound imports, relation parameters, interior stages and a recursive relation's `self`
 * are frozen values whose builder state lives in the WeakMaps here, so the builder trusts exactly the values it made.
 * A WeakMap holds nothing alive and is never enumerated, so it is no cache. Stored, closed and derived relations are
 * the schema package's values and are read through its protocol (schema/relation.ts); so are contexts and a role's world
 * relations (schema/world.ts).
 */
export interface QueryState<C extends Carriers = Carriers> {
	readonly desc: QueryDesc
	readonly heading: Heading
	/** The carriers of the heading's fields, or `described`. */
	readonly carriers: QueryCarriers<C>
	readonly schema: SchemaInfo
	/**
	 * The attachments its records carry, in the order they were attached; a union's, the query's it was built on, as its
	 * type states them (types/query/query.ts Query.rule): an arm that attaches makes a union of several headings, whose
	 * records are stored nowhere.
	 */
	readonly attached: ReadonlyArray<AttachedChild>
	/**
	 * The attachment children whose parent variables this query's top-level rules spell: such a query is part of an
	 * attachment child still being built, which checks they are its own when it returns, and is no Description of its
	 * own yet.
	 */
	readonly pending: ReadonlySet<BuilderScope>
}

/**
 * An attachment as the builder keeps it beside the value it attaches to, the runtime twin of the type's `attached`
 * phantom (types/query Attachment): its name, the delivery its author stated, and its child's state, the heading,
 * carriers and attachments of the query or ordered query the child callback returned, which the relations holding the
 * records read (schema/records.ts).
 */
export interface AttachedChild {
	readonly name: string
	readonly delivery: AttachmentDelivery
	readonly child: QueryState
}

const queries = new WeakMap<object, QueryState>()

/**
 * Registers a query value the builder made: its state, here, and in the owned registry (schema/protocol.ts ownQuery) the
 * schema or role it is over, its Description, read where it is asked for, and its heading as the builder typed it.
 */
export const registerQuery = <T extends object>(
	value: T,
	state: QueryState,
	desc: () => QueryDesc
): T => {
	queries.set(value, state)
	ownQuery(value, desc, { schema: state.schema.over.value, heading: headingTypings(state) })
	return value
}

/**
 * A query's heading as the builder typed it: each field's ScalarType and carrier where the builder typed both, and
 * nothing for a field it could not type (schema/protocol.ts HeadingTyping).
 */
export const headingTypings = (state: QueryState): ReadonlyMap<string, HeadingTyping> =>
	new Map(
		[...state.heading.fields].map(([name, typing]): readonly [string, HeadingTyping] => {
			const carrier = state.carriers.kind === "typed" ? state.carriers.carriers[name] : undefined
			return [
				name,
				typing.kind === "typed" && carrier !== undefined
					? { kind: "typed", scalar: typing.type, carrier }
					: { kind: "untyped" }
			]
		})
	)

export const queryState = (value: unknown): QueryState | undefined =>
	hasProperties(value) ? queries.get(value) : undefined

/**
 * The decoder of a query that has no columns to decode its rows with: a query rebuilt from its Description alone, or
 * one whose head holds a term the builder could not type (a variable of such a query). It delivers no records, and a
 * program that binds it is refused. Such a query is described, checked and lowered, never read.
 */
export const refusedRows = <A>(): RowDecoder<A> => decoderOf(refusedForm)

const refusedForm: DecoderForm = Object.freeze({ kind: "refused" })

/**
 * Refuses a query or rule that spells the parent variables of a pending attachment child where they are not visible: a
 * parent variable is visible only to the top-level rules of its attachment's own child, and a query or rule that spells
 * one is no complete relational stage to import as a query or an interior stage, store or describe.
 */
export const nonePending = (pending: ReadonlySet<BuilderScope>, label: string): void => {
	if (pending.size > 0) {
		throw malformed(
			label,
			"a parent variable used only in the rules of its attachment's own child: an imported query, an interior stage or a nested attachment receives it through Q.bind or its own parent variables"
		)
	}
}

/** The Description of a query value, refused while it spells the parent variables of a pending attachment child. */
export const publicDesc = (state: QueryState, label: string): QueryDesc => {
	nonePending(state.pending, label)
	return state.desc
}

/**
 * The heading a Description states without a schema: head field names, attachment names and recursive rows, typed
 * only where a field descriptor says so.
 */
export const stageHeading = (stage: QueryStageDesc, env: ScalarEnv): Heading => {
	switch (stage.kind) {
		case "rules":
		case "union": {
			const arms = stage.arms.map((arm) =>
				heading(
					Object.keys(arm.head).map((name) => [name, untyped] as const),
					arm.attach.map((a) => a.name)
				)
			)
			return unionHeading(stage.kind === "union" ? [stageHeading(stage.input, env), ...arms] : arms)
		}
		case "recursive":
			return fieldsHeading(stage.recursive.row, {}, env)
		case "attach":
			return withAttachment(stageHeading(stage.input, env), stage.attach.name)
		case "named":
		case "order":
		case "take":
		case "approx":
			return stageHeading(stage.input, env)
	}
}

/**
 * Where a source may be matched: anywhere; only in the rule whose interior stage it is; only in a recursive arm of its
 * own definition; a query or a bound import of one, in a rule over a level above the level it is written over; or a
 * derived relation, in a rule over a schema that declares it, the derived relation `name` of the definition `query`,
 * whatever the installation infers of its storage.
 */
type SourceScope =
	| { readonly kind: "anywhere" }
	| { readonly kind: "interior"; readonly ctx: RuleContext }
	| { readonly kind: "self"; readonly token: object }
	| { readonly kind: "written"; readonly over: Level }
	| { readonly kind: "declared"; readonly name: string; readonly query: QueryDesc }

const anywhere: SourceScope = Object.freeze({ kind: "anywhere" })

export interface SourceInfo {
	readonly desc: OpenSource
	readonly heading: Heading
	/**
	 * The carriers of the heading's fields: a described query's are the empty heading (headingOf), so v and an
	 * attachment read every field of it as carrying no column.
	 */
	readonly carriers: Carriers
	/** The relation variables over this source come from. */
	readonly origin: SourceOrigin
	/** Where the source may be matched (SourceScope). */
	readonly scope: SourceScope
	readonly label: string
}

const sources = new WeakMap<object, SourceInfo>()

export const registeredSource = (value: unknown): SourceInfo | undefined =>
	hasProperties(value) ? sources.get(value) : undefined

export const registerSource = <T extends object>(value: T, info: SourceInfo): T => {
	sources.set(value, info)
	return value
}

/**
 * A source value made outside this package, for a source kind whose builder lives elsewhere: a read-back's delta
 * sources are made by the ChangeSet package from the written relation's heading.
 */
export const sourceValue = <C extends Carriers>(
	desc: OpenSource,
	sourceHeading: Heading,
	carriers: C,
	label: string
): Built & Headed<C> =>
	registerSource(Object.freeze({ ...builtMark, heading: carriers }), {
		desc,
		heading: sourceHeading,
		carriers,
		origin: noOrigin,
		scope: anywhere,
		label
	})

/** Whether a value is a query or a bound query, whose rows a call's rows argument or a relation parameter's binding
 * reads (rowsSource). */
export const isRowsValue = (value: unknown): boolean =>
	registeredSource(value)?.desc.kind === "query" || queryState(value) !== undefined

/**
 * The rows of a query, read where a relation is taken, a call's rows argument or a relation parameter's binding: a
 * query or a bound query, its query and its bind map (RowsDesc), and where a source that reads them may be matched,
 * its source info's scope.
 */
export const rowsSource = (
	value: unknown,
	label: string,
	env: ScalarEnv
): { readonly info: SourceInfo; readonly rows: OpenRows } => {
	const info = sourceInfo(value, label, env)
	if (info.desc.kind !== "query") {
		throw malformed(label, "rows: a query or a bound query, Q.bind({ ... })")
	}
	return { info, rows: { kind: "rows", query: info.desc.query, bind: info.desc.bind } }
}

/**
 * The rows of a declared function's call as a source (query/build/call.ts): `desc`, its heading and its carriers the
 * function's result heading's, matched where its rows arguments may be, each a query or a bound query (`rows`): over the
 * highest of the levels they are written over (schema/level.ts highestLevel), every one a level of it, however many
 * query(S) built them over one S; or anywhere where it takes none. Rows arguments over levels none of which holds every
 * other are refused.
 */
export const callSourceValue = <C extends Carriers>(
	desc: OpenSource,
	sourceHeading: Heading,
	carriers: C,
	rows: ReadonlyArray<SourceInfo>,
	label: string
): Built & Headed<C> =>
	registerSource(Object.freeze({ ...builtMark, heading: carriers }), {
		desc,
		heading: sourceHeading,
		carriers,
		origin: noOrigin,
		scope: callScope(
			rows.flatMap((r) => (r.scope.kind === "written" ? [r.scope.over] : [])),
			label
		),
		label
	})

/** Where a call whose rows arguments are written over `levels` may be matched: over the highest, or anywhere for none. */
const callScope = (levels: ReadonlyArray<Level>, label: string): SourceScope => {
	if (!isNonEmpty(levels)) {
		return anywhere
	}
	const over = highestLevel(levels)
	if (over === undefined) {
		throw malformed(
			label,
			"rows arguments over levels of one schema, each a level of the highest of them"
		)
	}
	return { kind: "written", over }
}

/** A descriptor's carrier: its column and SQL type, as the registry admitted it. */
const descriptorCarrier = (descriptor: unknown, label: string): Carrier => {
	const field = describeField(descriptor, SourceLoc(label, []))
	if (!field.ok) {
		throw field.error
	}
	return Object.freeze({ column: field.value.column, sql: field.value.sql })
}

/**
 * The carriers of a stored or closed relation value's heading: each field's descriptor's, and a roster's id the code
 * column of the roster itself, read through the installation's names for its codes.
 */
const relationCarriers = (value: unknown, label: string): Carriers => {
	const named = namedRelation(value, label)
	const out: Record<string, Carrier> = {}
	switch (named.kind) {
		case "derived":
			return Object.freeze(out)
		case "relation":
		case "closedRelation":
			break
		case "closed":
			out["id"] = Object.freeze({
				column: codeColumn(named.name, named.roster.handles),
				sql: "code"
			})
			break
	}
	for (const [field, descriptor] of Object.entries(named.descriptors)) {
		out[field] = descriptorCarrier(descriptor, `${label} ${field}`)
	}
	return Object.freeze(out)
}

/** The carriers of a heading of field descriptors, each field's descriptor's: a call's heading of values' rows. */
export const descriptorCarriers = (
	descriptors: Readonly<Record<string, unknown>>,
	label: string
): Carriers => {
	const out: Record<string, Carrier> = {}
	for (const [field, descriptor] of Object.entries(descriptors)) {
		out[field] = descriptorCarrier(descriptor, `${label} ${field}`)
	}
	return Object.freeze(out)
}

/** The field descriptors a context value holds. */
const descriptorsOf = (
	value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> => (hasProperties(value["fields"]) ? value["fields"] : {})

/** The carriers of a context value's heading: each field's descriptor's. */
const contextCarriers = (value: Readonly<Record<string, unknown>>, label: string): Carriers => {
	const out: Record<string, Carrier> = {}
	for (const [field, descriptor] of Object.entries(descriptorsOf(value))) {
		out[field] = descriptorCarrier(descriptor, `${label} ${field}`)
	}
	return Object.freeze(out)
}

/**
 * What a derived or world relation's variables are carried by: its definition's carriers, which the builder knows when
 * the definition is a query value it made.
 */
const derivedCarriers = (value: Readonly<Record<string, unknown>>): Carriers => {
	const definition = queryState(value["definition"])
	return definition === undefined ? Object.freeze({}) : headingOf(definition.carriers)
}

/**
 * The heading of a stored, closed or derived relation value. A derived relation's fields are inferred at compilation,
 * so its value carries none.
 */
export const relationHeading = (value: unknown, env: ScalarEnv, label: string): Heading => {
	const named = namedRelation(value, label)
	if (named.kind === "closed") {
		const handles = named.roster
		const rosterEnv: ScalarEnv = {
			...env,
			roster: (name) =>
				name === named.name ? Roster.of(name, handles.order, handles.handles) : env.roster(name)
		}
		return heading(
			Object.entries(named.fields).map(
				([name, desc]) => [name, fieldTyping(named.descriptors[name], desc, rosterEnv)] as const
			),
			[]
		)
	}
	return named.kind === "derived"
		? fieldsHeading({}, {}, env)
		: fieldsHeading(named.fields, named.descriptors, env)
}

/**
 * What a derived or world relation's variables are typed by: its definition's heading, which the builder knows when the
 * definition is a query value it made.
 */
const derivedHeading = (
	value: Readonly<Record<string, unknown>>,
	env: ScalarEnv,
	label: string
): Heading => {
	const definition = queryState(value["definition"])
	if (definition !== undefined) {
		return definition.heading
	}
	return stageHeading(queryDescOf(value["definition"], label).stage, env)
}

/**
 * What a relation-like source is: an owned value's kind, or the kind a JavaScript caller's look-alike record states,
 * which schema/relation.ts relationDescOf re-admits through relation(...), closed.ordered(...) or closed.unordered(...).
 */
const relationKindOf = (value: Readonly<Record<string, unknown>>): OwnedKind | undefined => {
	const owned = ownedKind(value)
	if (owned !== undefined) {
		return owned
	}
	const spelled = value["kind"]
	return spelled === "relation" || spelled === "closed" || spelled === "closedRelation"
		? spelled
		: undefined
}

/** Whether a relation kind is an ordinary relation's, a roster's or a closed relation's: none when there is no kind. */
const isOrdinaryOrClosed = (kind: OwnedKind | undefined): boolean =>
	kind === "relation" || kind === "closed" || kind === "closedRelation"

/**
 * What a rule reads of `value` it matches or negates: a registered source's own; a query's, written over its schema; a
 * derived relation, a world entry or a stored relation, by its name, a derived relation whether or not the installation
 * stores it (the checker reads it as a relation, the lowering a live one through its definition, ir/derived.ts).
 */
export const sourceInfo = (value: unknown, label: string, env: ScalarEnv): SourceInfo => {
	if (!hasProperties(value)) {
		throw malformed(label, "a source: a relation, a query, a bound query or a relation parameter")
	}
	const registered = sources.get(value)
	if (registered !== undefined) {
		return registered
	}
	const query = queryState(value)
	if (query !== undefined) {
		if (isOrdered(query)) {
			throw malformed(
				label,
				"a Query, not an Ordered: take(k) closes an ordered query back into a set that can be matched"
			)
		}
		const stage = query.desc.stage
		return {
			desc: { kind: "query", query: publicDesc(query, label), bind: {} },
			heading: query.heading,
			carriers: headingOf(query.carriers),
			origin: noOrigin,
			scope: { kind: "written", over: query.schema.over },
			/** A named query is labelled by its diagnostic name. */
			label: stage.kind === "named" ? stage.name : "query"
		}
	}
	const derived = derivedDraftOf(value)
	if (derived !== undefined) {
		return {
			desc: { kind: "relation", name: derived.name },
			heading: derivedHeading(value, env, label),
			carriers: derivedCarriers(value),
			origin: relationOrigin(derived.name),
			scope: { kind: "declared", name: derived.name, query: derived.query },
			label: derived.name
		}
	}
	const world = worldDraftOf(value)
	if (world !== undefined) {
		return {
			desc: { kind: "relation", name: world.name },
			heading: derivedHeading(value, env, label),
			carriers: derivedCarriers(value),
			origin: relationOrigin(world.name),
			scope: anywhere,
			label: world.name
		}
	}
	const context = contextDescOf(value)
	if (context !== undefined) {
		return {
			desc: { kind: "context", context },
			heading: fieldsHeading(context.fields, descriptorsOf(value), env),
			carriers: contextCarriers(value, label),
			origin: relationOrigin(context.name),
			scope: anywhere,
			label: context.name
		}
	}
	if (isOrdinaryOrClosed(relationKindOf(value))) {
		const name = relationDescOf(value, label).name
		return {
			desc: { kind: "relation", name },
			heading: relationHeading(value, env, label),
			carriers: relationCarriers(value, label),
			origin: relationOrigin(name),
			scope: anywhere,
			label: name
		}
	}
	throw malformed(
		label,
		"a source: a relation, closed, derived or world relation, a context, a query, a bound query, a relation parameter, an interior stage or self"
	)
}

/**
 * A relation-valued parameter: a heading of at least one field descriptor, as a relation has, or an ordinary relation
 * whose heading types it. Its value holds its heading of carriers, the fields' descriptors.
 */
export const relationParam = <C extends Carriers>(
	name: string,
	headingArg: unknown,
	carriers: C,
	env: ScalarEnv,
	label: string
): Built & { readonly heading: C } => {
	if (hasProperties(headingArg)) {
		const kind = relationKindOf(headingArg)
		if (kind === "derived" || derivedDraftOf(headingArg) !== undefined) {
			throw malformed(
				label,
				"a heading of field descriptors or an ordinary relation, not a derived relation"
			)
		}
		if (isOrdinaryOrClosed(kind)) {
			const desc = relationDescOf(headingArg, label)
			if (desc.kind !== "relation") {
				throw malformed(
					label,
					"a heading of field descriptors or an ordinary relation, not a closed relation"
				)
			}
			return registerSource(Object.freeze({ ...builtMark, heading: carriers }), {
				desc: { kind: "paramOf", name, relation: desc.name },
				heading: relationHeading(headingArg, env, label),
				carriers,
				origin: noOrigin,
				scope: anywhere,
				label: `parameter ${name}`
			})
		}
	}
	if (!isPlainRecord(headingArg)) {
		throw malformed(label, "a heading: a record of field descriptors")
	}
	const fields = Object.entries(headingArg)
	if (fields.length === 0) {
		throw malformed(
			label,
			"a heading of at least one field: a relation parameter is a list of rows, matched like a table"
		)
	}
	const descs: Record<string, FieldDesc> = {}
	for (const [field, descriptor] of fields) {
		descs[field] = fieldDesc(descriptor, `${label} ${field}`)
	}
	return registerSource(Object.freeze({ ...builtMark, heading: carriers }), {
		desc: { kind: "param", name, heading: descs },
		heading: fieldsHeading(descs, headingArg, env),
		carriers,
		origin: noOrigin,
		scope: anywhere,
		label: `parameter ${name}`
	})
}
