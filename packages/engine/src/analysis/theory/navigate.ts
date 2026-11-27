import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { equalityClosure } from "@bjornpagen/grizzle-text/base/equality"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	flatMapNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import { refuse } from "#compiler/analysis/theory/build.ts"
import type { QueryColumns } from "#compiler/analysis/theory/columns.ts"
import {
	atColumn,
	boundIn,
	equal,
	isBare,
	mapBindings,
	mapLeaves,
	varRef,
	varsOf
} from "#compiler/analysis/theory/leaves.ts"
import { type Successor, successorOf } from "#compiler/analysis/theory/successor.ts"
import type { FieldContainment, RegionFacts } from "#compiler/analysis/theory/unit.ts"
import { leavesOf, ruleLeaves } from "#compiler/check/scan.ts"
import { canonicalEquals } from "#compiler/core/canonical.ts"
import type { SourceLoc } from "#compiler/core/loc.ts"
import { compareStrings, type Direction } from "#compiler/core/order.ts"
import { deepFreeze, mapRecord } from "#compiler/core/record.ts"
import {
	callsOf,
	type Channel,
	descIdentity,
	exprChildren,
	headTerms,
	type InferredBindings,
	type InferredExpr,
	type InferredMatch,
	type InferredQuery,
	type InferredRule,
	type InferredSource,
	mapBindMap,
	queryParamNames,
	type VarDesc
} from "#compiler/ir/desc.ts"
import { equalityIsIdentity, type ScalarType } from "#compiler/ir/scalar.ts"

/**
 * Navigation: a conjunctive rule over stored relations as one chain of steps (ir/desc.ts SourceDesc `step`, ir/rel.ts
 * Step), each a read of one stored or closed relation alone, by the columns the steps before it bound. A write
 * member's query and every query the judge reads (`navigateQuery`) are such rules: a join of the live definitions its
 * matches import, each a join of a few stored relations, or a read of one relation that negates such a join.
 *
 * Navigation re-associates the rule's conjunction; it changes no fact the rule derives. Each imported query the rule
 * matches is inlined, its variables renamed apart, its parameters replaced by what its bind map binds them to, and its
 * head equated with the terms the match binds it at (`#inline`), a bare literal of either, which stands for the
 * import's column, typed at that column's descriptor (analysis/theory/columns.ts, leaves.ts atColumn); a variable then
 * bound by no match is the term an equality defines (`#defined`), so a literal it replaces a variable by is a term of
 * the variable's column, which stands wherever the variable stood, first among them. The matches are then read in an
 * order of their own (`#chain`): from the values the rule holds, its parameters and literals, each next match the
 * narrowest lookup (Navigation `narrower`), by what the schema states alone, never an estimate: one bound at a key of
 * its relation, which reads one row at most; then, of two relations one is contained in over every row, the contained
 * read keyed at more than the container's image of it, which it reads no more rows than, or else the container's
 * lookup keyed at more than the contained read's image, which narrows the container's rows that hold the contained
 * read's; then the one with the most columns keyed so far, bound
 * to a parameter or to a variable the steps placed bound, directly or by an equality with them, then the one with the
 * most columns bound at all, literals among them; then one whose every row is beside a row of another that reads every
 * row of its relation (Navigation `within`: a containment the schema states of its relation into the other's over
 * every row, at the variables both bind; #chain `readsAll`), then the earliest declared among equals: a literal alone
 * is no key, a constant every key's rows may share, so a read a literal alone binds never goes before one a key binds.
 * That is how a rule's probe starts from the row its write touched; how a member walks a qti package: from the
 * package's documents by its own key, down to a node's children by (package, path, parent), and up to a node's parent
 * by its primary key, never by (package, path) alone while a narrower lookup is left, nor by an item's placed
 * expressions, (package, path) under a placement; and how a check over every row of a relation whose rows each sit
 * beside a row of another starts at its rows, never at every row of the other.
 *
 * Each match is its own step: an import of one rule over its relation, every column a variable the steps before it bound
 * read through a channel (ir/desc.ts Channel) its bind map binds to that variable, every parameter of the rule passed in
 * as itself, its other columns delivered under head names of its own. A condition is placed inside the first step after
 * which every variable it reads is bound. A relational filter, a negation or an existence, is a chain of its own,
 * correlated through its channels: a filtered relation one step, a filtered query each rule of it navigated with its
 * head equated with the terms it is filtered at.
 *
 * Each step is a Step node, which every lowering prints as a subquery PostgreSQL never pulls up (lower/conservative/step),
 * read LATERAL after the steps it reads: PostgreSQL plans each step alone, a lookup of one relation by the values the
 * row before it holds, and cannot reorder two steps or join them at once, so no estimate it makes, with statistics or
 * none, can turn the walk into a join of every relation the rule reads.
 */

const channel: Channel = { kind: "channel" }

/** The variables `e` reads. */
const readsOf = (e: InferredExpr): ReadonlySet<string> => varsOf(e, new Set())

/**
 * Whether a term a read is bound by is keyed: it reads a variable a step bound or a parameter, a value of the row or
 * the call at hand. A literal alone is no key: it is a constant every key's rows may share (a kind, a flag), so a read
 * bound by literals alone reads every key's rows.
 */
const keyedTerm = (e: InferredExpr): boolean => readsOf(e).size > 0 || leavesOf(e).params.length > 0

/**
 * `e` read through each relabel of it: `Type.base(x)` is x's own datum under its base type (scalar/compute/typing.ts
 * restates its operand's type and keeps its representation), so an equality of a term with `Type.base(x)` fixes x as
 * one with x does, and PostgreSQL seeks x's column by it, a domain's value compared under its base type a binary
 * coercion its index matching reads through. qti-pie's LinearPresentations equates the after member's prior with
 * `Type.base(place)` of the member before it: read as no binding, the member's MemberPlace stood at (child, stage)
 * alone beside its TestPresented, the tie went to the written order, and the judge of a presentation read every
 * presentation of its sitting before the one place its key (child, stage, place) holds (metis's FASTMATH, 2026-11-25).
 */
const relabeled = (e: InferredExpr): InferredExpr => (e.kind === "base" ? relabeled(e.arg) : e)

/**
 * The subject and suffix of a suffix test, `endsWith(x, t)` or `endsWith(x, t) = true` (Text.endsWith), whose subject
 * is a variable: what a read binding `x` is sought by once `t` is known, the B-tree on its column's suffix key serving
 * it (sql/suffix.ts), as an equality's term keys the column it binds.
 */
const suffixTestOf = (
	c: InferredExpr
): { readonly subject: string; readonly suffix: InferredExpr } | undefined => {
	const test =
		c.kind === "compare" && c.op === "eq" && c.right.kind === "literal" && c.right.value === true
			? c.left
			: c
	if (test.kind !== "compute" || test.fn !== "endsWith") {
		return undefined
	}
	const [subject, suffix] = test.args
	return subject?.kind === "var" && suffix !== undefined
		? { subject: subject.var, suffix }
		: undefined
}

/**
 * How read `read` is looked up from the values known so far: its columns sought by a keyed term, an equality's or a
 * suffix seek's (`keyed`), and its columns an equality binds to a value known so far, a keyed term or a literal
 * (`bound`), each of whose rows the lookup reads holds there.
 */
interface Lookup {
	readonly read: Read
	readonly keyed: ReadonlySet<string>
	readonly bound: ReadonlySet<string>
}

/** Whether lookup `a` is narrower than `b` by their columns alone (Navigation `narrower`): more keyed, then more bound. */
const counted = (a: Lookup, b: Lookup): boolean =>
	a.keyed.size > b.keyed.size || (a.keyed.size === b.keyed.size && a.bound.size > b.bound.size)

/** Whether every member of `small` is one of `large`, which holds more. */
const holdsMore = (large: ReadonlySet<string>, small: ReadonlySet<string>): boolean =>
	large.size > small.size && [...small].every((x) => large.has(x))

/** Whether a relational filter reads no variable of its rule, by its bindings or by the bind map of the query it reads. */
const readsNoVariable = (a: Filtered): boolean => {
	const leaves = leavesOf(a)
	return leaves.vars.size === 0 && leaves.parents.size === 0
}

/** The scalar terms an import's bind map binds its parameters to, or undefined where one binds a relation parameter. */
const scalarBinds = (
	bind: Extract<InferredSource, { readonly kind: "query" }>["bind"]
): ReadonlyMap<string, InferredExpr> | undefined => {
	const out = new Map<string, InferredExpr>()
	for (const [name, b] of Object.entries(bind)) {
		if (b.kind === "relationParam" || b.kind === "rows") {
			return undefined
		}
		out.set(name, b)
	}
	return out
}

/**
 * What a read reads: a stored or closed relation, or the delta of one, the rows a transaction wrote of it, which a rule
 * probe over its region matches (analysis/theory/query.ts probe); or an import the rule's unfolding reads more than
 * once that joins (`sharedImports`), which the step that reads it reads whole, as the checker builds it once for every
 * read and the lowering computes it once per unit (lower/optimize/cte-policy).
 */
type ReadSource = Extract<InferredSource, { readonly kind: "relation" | "delta" | "query" }>

/** One match of a stored or closed relation or of a delta, its bindings over the rule's variables. */
interface Read {
	readonly source: ReadSource
	readonly bindings: InferredBindings
	readonly loc: SourceLoc
}

/**
 * The field a read's column is a field of, which names a variable navigation mints for it: the relation's own, or the
 * relation a delta's rows were written to; none for an import's head field.
 */
const originOf = (
	source: ReadSource,
	field: string
): { readonly relation: string; readonly field: string } | undefined => {
	switch (source.kind) {
		case "relation":
			return { relation: source.name, field }
		case "delta":
			return { relation: source.relation, field }
		case "query":
			return undefined
	}
}

/**
 * The type column `column` of `source` holds (analysis/theory/columns.ts QueryColumns): a relation's field, a delta's
 * or a relation parameter's relation's, off the schema; an imported query's or a step's column at the variable a rule of
 * it delivers there, by the column a match of that rule binds the variable at, so a column the schema types takes no
 * check; else as the checker types the query's heading, once for its identity (QueryColumns `type`), undefined where
 * that check refuses the query read apart. Undefined for any other source.
 */
const sourceType = (
	columns: QueryColumns,
	source: InferredSource,
	column: string
): ScalarType | undefined => {
	switch (source.kind) {
		case "relation":
			return columns.field(source.name, column)
		case "delta":
			return columns.field(source.relation, column)
		case "paramOf":
			return columns.field(source.relation, column)
		case "query":
		case "step": {
			const stage = source.query.stage
			for (const arm of stage.kind === "rules" ? stage.arms : []) {
				const head = arm.head[column]
				if (head?.kind !== "var") {
					continue
				}
				for (const m of arm.matches) {
					for (const [at, e] of Object.entries(m.bindings)) {
						const type =
							e.kind === "var" && e.var === head.var ? sourceType(columns, m.source, at) : undefined
						if (type !== undefined) {
							return type
						}
					}
				}
			}
			return columns.type(source.query, column)
		}
		case "param":
		case "call":
		case "callField":
		case "split":
		case "series":
		case "context":
		case "row":
		case "interior":
		case "self":
		case "arm":
			return undefined
	}
}

/**
 * Whether a column holds a type whose equality is identity (ir/scalar.ts equalityIsIdentity), as `sourceType` types it;
 * a column no check types is held to be of none, so navigation keeps every binding a merge may read there.
 */
const identityAt = (columns: QueryColumns, source: InferredSource, column: string): boolean => {
	const type = sourceType(columns, source, column)
	return type !== undefined && equalityIsIdentity(type)
}

/**
 * How navigation reads the imports a rule's unfolding multiplies, an import of one rule read more than once that joins
 * and every import of several rules (`sharedImports`): `perStatement`, each one read, its query navigated as a query of
 * its own, restricted inside to the parameters its reads fix it at, a whole rule's unit channels among them, which the
 * checker builds as one node for every read of one import (check/checker.ts #imported) and the lowering places
 * (lower/optimize/cte-policy): restricted by the unit, inside the region it is read in, computed once per unit (rule
 * 3b), and restricted by nothing, once in the statement (rules 5 and 6); `perRead`, a write member's query, whose
 * checker builds an import at every read, every import of one rule inlined at each read and each union kept whole, one
 * node (`sharedImports`), never distributed into the rule's conjunctions, the product of the unions' widths at every
 * depth (edullm's evaluate, distributed, planned in 5.45 GB, 332 MB with each union whole), its filters left as written
 * over a chain of steps (`navigatedRule`). Every rule statement, the judge's and a check over every row alike, reads
 * `perStatement`, over its region (`RegionExtent`): navigation never distributes a rule into the conjunctions of a
 * union it reads, the product of the unions' widths at every depth.
 */
export type ImportSharing =
	| { readonly kind: "perStatement"; readonly extent: RegionExtent }
	| { readonly kind: "perRead" }

/**
 * What a rule statement's region holds: the units a transaction wrote (`units`), a probe's or a whole rule's unit
 * statement, or every row (`every`), a rule's check over every row, which the migration that adds the rule runs. Over
 * the units, an import of one rule no parameter restricts, which read whole reads every unit's rows, is read at each
 * read instead, a step of the chain keyed by the steps before it (`Navigator.rule`): a probe of the assembled catalog
 * read qti's attribute rows of one name and kinds for every package, the import whole at the chain's head, where read
 * at each read it reads the delta's package's. Over every row, it is read whole, once: the check reads every unit
 * anyway, and at each read it was read again for every row of every read before it (test/unit/physical/judge-size).
 * An import of several rules stays whole over either.
 */
export type RegionExtent = "units" | "every"

/**
 * What a query's navigation reads beside the query (Navigation `navigated`): how its imports are shared (ImportSharing),
 * a read's or a statement's over its region's extent, each navigating an import of one rule apart (`restrictedFlat`).
 */
type SharingKey = "perRead" | RegionExtent

/** The key of `sharing` (`SharingKey`). */
const sharingKey = (sharing: ImportSharing): SharingKey =>
	sharing.kind === "perRead" ? "perRead" : sharing.extent

/** An import's bind map, its terms in the scope of the rule the unfolding reads it in. */
type Binds = ReadonlyMap<string, InferredExpr>

/**
 * A navigation of a compile's queries (`navigateQuery`): each query they read navigated once for its identity (ir/desc.ts
 * descIdentity), and what they read of each rule (`reads`), computed once for the rule. Every read of a query of one
 * identity is the one navigation of it, which the checker, keying an import by its query's identity (check/session.ts
 * ResolvedImports), builds as one node for all of them; and a chain of unions, each rule of a level reading the level
 * below, navigates each level once
 * for each set of values its rules read it at, where navigated at each read apart, every level was navigated once for
 * every path down the chain to it, the product of the unions' widths at every depth above it. Its work is linear in the
 * queries and rules its compile reads, never in the paths through them. Its owner is the compile whose queries share
 * it: a write's every member (write/frontend/compile.ts), whose queries read the same imports, each navigated once for
 * the ChangeSet where each member navigated and digested them again (edullm's evaluate: 97 members over one call's
 * imports); a judge's one statement (physical/ddl/rules.ts). With the containments its chains are ordered by
 * (`within`).
 */
export class Navigation {
	/**
	 * The navigation of the first query of each identity this navigation read, by how it shares its imports and by the
	 * identity: the whole of what the navigation reads beside the schema's facts, so one query navigated under two
	 * extents is navigated under each, where a navigation by identity alone read a query navigated under one extent at
	 * the other, a probe's units for a check over every row.
	 */
	readonly #navigations: Readonly<Record<SharingKey, Map<string, InferredQuery>>> = {
		perRead: new Map(),
		units: new Map(),
		every: new Map()
	}
	/** What navigation reads of each rule this navigation asked about (`reads`), by the rule. */
	readonly #reads = new Map<InferredRule, RuleReads>()
	/** Whether each rule this navigation asked about reads a chain of steps (`overSteps`), by the rule. */
	readonly #overSteps = new Map<InferredRule, boolean>()
	/**
	 * The containments the schema states over every row of their source (RegionFacts `containments`, no selection), by
	 * the source: a containment over the rows a selection admits says nothing of the rows a read of the whole relation
	 * reads.
	 */
	readonly #containments: ReadonlyMap<string, ReadonlyArray<FieldContainment>>
	/** Each stored relation's keys over every row, its primary key first (RegionFacts `keys`). */
	readonly #keys: RegionFacts["keys"]

	constructor(facts: RegionFacts) {
		this.#containments = Map.groupBy(
			facts.containments.filter((c) => c.selection.length === 0),
			(c) => c.from
		)
		this.#keys = facts.keys
	}

	/**
	 * Whether lookup `a` is narrower than `b` (Navigator #chain), by what the schema states of their relations, never an
	 * estimate, with statistics or none:
	 *
	 * - a lookup whose bound columns hold a key of its relation (`#unique`) reads at most one row, so it is narrower than
	 *   one whose bound columns hold none, which may read many: qti's node at the key (package, path, start) an operand's
	 *   row binds, its parent then, against the placed expressions of the operand's item instance;
	 * - else the one a containment between the two relations orders first (`#imaged`);
	 * - else the one with more columns keyed, then more bound (`counted`).
	 */
	narrower(a: Lookup, b: Lookup): boolean {
		return this.#ordered(a, b) ?? counted(a, b)
	}

	/** Whether the keys and containments the schema states order `a` before `b` (`narrower`), or undefined. */
	#ordered(a: Lookup, b: Lookup): boolean | undefined {
		const unique = this.#unique(a)
		if (unique !== this.#unique(b)) {
			return unique
		}
		const imaged = this.#imaged(a, b)
		return imaged === this.#imaged(b, a) ? undefined : imaged
	}

	/** Whether lookup `l`'s bound columns hold a key of its relation (RegionFacts `keys`), so it reads one row at most. */
	#unique(l: Lookup): boolean {
		return this.keysOf(l.read.source).some((key) => key.every((f) => l.bound.has(f)))
	}

	/** The keys of a read's relation over every row (RegionFacts `keys`), its primary key first; none of any other source. */
	keysOf(source: ReadSource): ReadonlyArray<ReadonlyArray<string>> {
		return source.kind === "relation" ? (this.#keys.get(source.name) ?? []) : []
	}

	/**
	 * Whether a containment between their relations over every row, each of its pairs one variable both reads bind
	 * (`#imagesOf`), orders lookup `a` before `b`. Where x ⊆ y so, each row x's lookup reads is beside its own row of y at
	 * the image of x's keyed columns, so x reads no more rows than y would at that image: x goes first where its image
	 * holds more than y's keyed columns, a proof that x is no wider. And the container's lookup keyed at more than the
	 * contained read's image goes first: the contained read's rows are held to the container's rows at that image, which
	 * the container's lookup narrows, a rule the schema's facts alone decide, no proof, as one node may have ten thousand
	 * children where its item has one expression. Keyed columns alone, as a literal alone is no key: a read of Item at a
	 * parent literal goes no earlier for it than Rare's rows contained in it. qti's placed
	 * expressions of an item's instance, at (package, assembly, instance, path), are contained in Node at (package, path,
	 * start), at the image (package, path), every expression of the item: a node's children at (package, path, parent)
	 * are narrower, where the count of their columns put the expressions first, every reference beside every
	 * expression of its item (edullm's _08e9e8ae, 33.6 M pairs at 42 items, 364 s of its COMMIT).
	 */
	#imaged(a: Lookup, b: Lookup): boolean {
		return (
			this.#imagesOf(a, b).some((image) => holdsMore(image, b.keyed)) ||
			this.#imagesOf(b, a).some((image) => holdsMore(a.keyed, image))
		)
	}

	/**
	 * The images of lookup `x`'s keyed columns in `y`'s relation, one by each containment of x's relation into y's over
	 * every row whose every pair is one variable both reads bind (`#between`), and under which x's rows at its lookup
	 * are each beside a row of y of their own: a key of x's relation among x's bound columns and the containment's
	 * fields, so two rows x reads differ at a field the containment pairs. Each image is the fields of y paired with a
	 * keyed column of x.
	 */
	#imagesOf(x: Lookup, y: Lookup): ReadonlyArray<ReadonlySet<string>> {
		const source = x.read.source
		const keys = source.kind === "relation" ? (this.#keys.get(source.name) ?? []) : []
		return this.#between(x.read, y.read).flatMap((c) => {
			const paired = new Set(c.pairs.map((p) => p.from))
			return keys.some((key) => key.every((f) => x.bound.has(f) || paired.has(f)))
				? [new Set(c.pairs.flatMap((p) => (x.keyed.has(p.from) ? [p.to] : [])))]
				: []
		})
	}

	/**
	 * The containments the schema states of read `a`'s stored relation into read `b`'s over every row (`#containments`),
	 * each of whose pairs of fields is one variable both reads bind.
	 */
	#between(a: Read, b: Read): ReadonlyArray<FieldContainment> {
		if (a.source.kind !== "relation" || b.source.kind !== "relation") {
			return []
		}
		const to = b.source.name
		return (this.#containments.get(a.source.name) ?? []).filter(
			(c) =>
				c.to === to &&
				c.pairs.every((p) => {
					const x = a.bindings[p.from]
					const y = b.bindings[p.to]
					return x?.kind === "var" && y?.kind === "var" && x.var === y.var
				})
		)
	}

	/**
	 * Whether every row read `a` reads is beside a row of the relation read `b` reads: both read stored relations, and
	 * the schema states a's relation contained in b's over every row (`#containments`), each pair of fields one variable
	 * both reads bind. A law every committed state holds, it orders a chain and never what the chain derives: where `b`
	 * reads every row of its relation (Navigator #chain `readsAll`), a chain that starts at `a` reads a's rows, each of
	 * which meets a row of `b` by the variables it binds, where one that starts at `b` reads every row of b's relation,
	 * each beside few of a's rows or none, as a check over every row of qti's typed field values, each beside its node,
	 * read every node.
	 */
	within(a: Read, b: Read): boolean {
		return this.#between(a, b).length > 0
	}

	/**
	 * `query` navigated by `navigate` with its imports shared as `sharing`: the navigation of the first query of its
	 * identity this navigation read under that sharing, that query itself where its navigation changes nothing.
	 */
	navigated(
		query: InferredQuery,
		sharing: ImportSharing,
		navigate: (query: InferredQuery) => InferredQuery
	): InferredQuery {
		const navigations = this.#navigations[sharingKey(sharing)]
		const identity = this.identity(query)
		const known = navigations.get(identity)
		if (known !== undefined) {
			return known
		}
		const navigated = navigate(query)
		navigations.set(identity, navigated)
		return navigated
	}

	/**
	 * A navigated query's identity (ir/desc.ts descIdentity), which every query a navigation reads encodes, each part
	 * digested once for the process (descIdentities): in every navigation, and with what a ChangeSet or an owned schema
	 * digested. A query is frozen before it is digested (core/record.ts deepFreeze, which walks only what is not frozen
	 * yet), as every Description is, so the queries navigation builds, restricted inside an import and navigated, keep
	 * their tokens as the declared ones do.
	 */
	identity(query: InferredQuery): string {
		const identity = descIdentity(deepFreeze(query))
		if (!identity.ok) {
			defect(`a navigated query encodes: ${identity.error.message}`)
		}
		return identity.value
	}

	/**
	 * The key two reads of an import in one rule's unfolding share exactly when they read the same rows: the semantic
	 * identity of its query and of the terms its bind map binds its parameters to, as the outermost rule reads them, so
	 * two matches of one query at one parameter's values, a whole rule's unit channels among them, share it, and one
	 * bound to a variable of an inlined rule, renamed apart at each inlining, shares it with none. It is their identity
	 * digest (core/fingerprint.ts identityDigest), each query's frozen parts digested once for the whole navigation
	 * however many reads and identities of it are asked, where their canonical text spelled each read of a query again:
	 * a chain of unions each rule of which reads the level below spells its leaf the product of the unions' widths times.
	 */
	importKey(query: InferredQuery, bind: Binds): string {
		const key = descIdentity([query, [...bind].toSorted(([a], [b]) => compareStrings(a, b))])
		if (!key.ok) {
			defect(`an import's key encodes: ${key.error.message}`)
		}
		return key.value
	}

	/**
	 * What navigation reads of `rule` (`RuleReads`), read once for each rule however many reads of its import ask: the
	 * rules of a chain of unions, each rule of a level reading the level below, are each read once, where each read of
	 * a union read its rules again, once for every path down the chain to them.
	 */
	reads(rule: InferredRule): RuleReads {
		const known = this.#reads.get(rule)
		if (known !== undefined) {
			return known
		}
		const reads = ruleReads(this.successorFold(rule) ? foldsRemoved(rule) : rule, (r) =>
			this.reads(r)
		)
		this.#reads.set(rule, reads)
		return reads
	}

	/**
	 * Whether `rule`'s one fold reads a successor of its matches (`successorBeside`): one row of a relation per binding of
	 * its other matches, which its chain reads by one descent (`Navigator.#chain`), so navigation chains the rule whole,
	 * its fold over the chain, as it chains a rule that folds nothing (`reads`).
	 */
	successorFold(rule: InferredRule): boolean {
		return rule.matches.some((m) => successorBeside(rule, m, this) !== undefined)
	}

	/**
	 * Whether `rule` reads a chain of steps navigation reads no further (`RuleReads`), its filters left to be navigated
	 * after it (`Navigator.filteredOverSteps`): it matches a step, or an import of a rule that does, a probe's rows over
	 * its region (analysis/theory/query.ts overRegion) and the union of them its meeting part reads; and its head folds
	 * and produces nothing and it attaches and nests nothing, as a chain's rule does. Asked once for each rule, as
	 * `reads` is: every read of a query of one identity is the one navigation of it (`navigated`), so a chain of unions,
	 * each rule of a level importing the level below, asks each level's rules once, where asked again at each read the
	 * walk down an import of two rules took both, and a chain d levels deep was walked 2^d times (3.5 M calls at depth 16,
	 * test/unit/analysis/navigation-work).
	 */
	overSteps(rule: InferredRule): boolean {
		const known = this.#overSteps.get(rule)
		if (known !== undefined) {
			return known
		}
		const over =
			rule.interiors.length === 0 &&
			rule.attach.length === 0 &&
			Object.values(rule.head).every((h) => h.kind !== "aggregate" && h.kind !== "producer") &&
			rule.matches.some(
				(m) =>
					m.source.kind === "step" ||
					(m.source.kind === "query" &&
						m.source.query.stage.kind === "rules" &&
						m.source.query.stage.arms.some((arm) => this.overSteps(arm)))
			)
		this.#overSteps.set(rule, over)
		return over
	}
}

/**
 * `flat` with each import it reads whole (`sharedImports`) restricted inside to the parameters its bindings are fixed
 * to (`fixedTerms`), a whole rule's unit channels among them, and navigated as a query of its own from them
 * (`boundInside`, `navigateQuery`): every read of it at those values reads one import, which the checker builds once
 * (check/checker.ts #imported) and the lowering places by what restricts it (lower/optimize/cte-policy), its other
 * bindings each read's own, a join of its rows. Of a union, the rules whose head fixes a field the read binds to
 * another literal are dropped (`armsAt`): no row of theirs meets the read, so a selection of one rule of a union by the
 * literal its head fixes, qti's statements of one required fact (`select(PackageFact, fact = author)`), computes that
 * rule alone. The keys of the imports of one rule no parameter restricts over the units a transaction wrote
 * (`unrestricted`, RegionExtent `units`): `Navigator.rule` reads those at each read again, keyed by the steps before.
 * And the reads of the imports of several rules no parameter restricts over those units (`partnered`), each still one
 * read of its one node, which the chain places after the steps that bind its columns, its partners (`#chain`).
 */
/**
 * `source`, an import read at `bindings`, with each rule of its union whose head fixes a field the read binds to another
 * literal dropped (`fixed`, the rule's fixed terms): it delivers no row the read meets. Its bind map binds only the
 * parameters the rules it keeps read. Itself where no rule is dropped, or where every rule would be.
 */
const armsAt = (
	source: Imported,
	bindings: InferredBindings,
	fixed: (term: InferredExpr) => InferredExpr | undefined
): Imported => {
	const stage = source.query.stage
	if (stage.kind !== "rules" || stage.arms.length === 1) {
		return source
	}
	const literals = Object.entries(bindings).flatMap(([field, e]) => {
		const held = fixed(e) ?? e
		return held.kind === "literal" ? [[field, held] as const] : []
	})
	const meets = (arm: InferredRule): boolean =>
		literals.every(([field, literal]) => {
			const head = arm.head[field]
			return head?.kind !== "literal" || canonicalEquals(head.value, literal.value)
		})
	const [first, ...rest] = stage.arms.filter(meets)
	if (first === undefined || rest.length + 1 === stage.arms.length) {
		return source
	}
	const arms: NonEmptyReadonlyArray<InferredRule> = [first, ...rest]
	const read = new Set(
		arms.flatMap((arm) =>
			ruleLeaves(arm, true).params.flatMap((p) => (p.kind === "param" ? [p.name] : []))
		)
	)
	return {
		...source,
		bind: Object.fromEntries(Object.entries(source.bind).filter(([name]) => read.has(name))),
		query: { ...source.query, stage: { ...stage, arms } }
	}
}

/**
 * Whether an import of the one rule `rule`, read over the units a transaction wrote, is read whole and before every step
 * (`sharedWithin`): its head calls a declared function, and every row it derives is read from the rows the transaction
 * wrote, its rule matching a delta or an import each rule of which is so read (`fromRegion`), so read whole it reads no
 * unit's rows but those. Its call is evaluated over its own rows, once per distinct row (ir/expr.ts evaluatesCall), where
 * read at each read, or partnered among the steps that restrict it, it stood in a step keyed by the steps before and
 * ran again for every row they deliver: the gain of a closed delta form (analysis/theory/query.ts sharedCalls), whose
 * calls one import computes over the distinct arguments its arms deliver.
 */
const callsOnce = (rule: InferredRule): boolean => callsOf(rule.head).size > 0 && fromRegion(rule)

/** Whether every row `rule` derives is read from the rows a transaction wrote (`callsOnce`). */
const fromRegion = (rule: InferredRule): boolean =>
	rule.matches.some(
		(m) =>
			m.source.kind === "delta" ||
			(m.source.kind === "query" &&
				m.source.query.stage.kind === "rules" &&
				m.source.query.stage.arms.every(fromRegion))
	)

const sharedWithin = (
	flat: Flat,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
	interned: Navigation
): {
	readonly flat: Flat
	readonly unrestricted: ReadonlySet<string>
	readonly partnered: ReadonlySet<Read>
} => {
	const fixed = flatFixed(flat, loc)
	/** A fixed term an import is restricted inside to: one that reads a parameter, a channel among them. */
	const byParameter = (term: InferredExpr): InferredExpr | undefined => {
		const held = fixed(term)
		return held !== undefined && leavesOf(held).params.length > 0 ? held : undefined
	}
	const unrestricted = new Set<string>()
	const partnered = new Set<Read>()
	const reads = flat.reads.map((r): Read => {
		if (r.source.kind !== "query") {
			return r
		}
		const read = armsAt(r.source, r.bindings, fixed)
		const inside = boundInside(read, r.bindings, byParameter, columns)
		const stage = r.source.query.stage
		const overUnits =
			inside === read &&
			sharing.kind === "perStatement" &&
			sharing.extent === "units" &&
			stage.kind === "rules" &&
			!(stage.arms.length === 1 && callsOnce(stage.arms[0]))
		if (overUnits && stage.arms.length === 1) {
			unrestricted.add(interned.importKey(r.source.query, scalarBinds(r.source.bind) ?? new Map()))
			return r
		}
		const navigated: Read = {
			...r,
			source: { ...inside, query: navigatedQuery(inside.query, loc, columns, sharing, interned) }
		}
		if (overUnits) {
			partnered.add(navigated)
		}
		return navigated
	})
	return { flat: { ...flat, reads }, unrestricted, partnered }
}

/** The imports a rule's navigation reads whole, each one read of one node, by key (`importKey`). */
type KeptImports = ReadonlySet<string>

/**
 * The imports `rule`'s unfolding reads whole (`KeptImports`), by key (`importKey`). An import of one rule that the
 * unfolding reads more than once and that joins is one, each the outermost of its kind first: navigation reads it
 * whole, the same rows at every read, where inlining it at every read multiplies the rule's reads by its own, and by
 * its reads' at every level below it, so a chain of definitions each reading the one below it twice reads its leaf two
 * to the chain's depth times. An import of several rules is one wherever it is read, its rules navigated inside it
 * (`navigateQuery`): distributed, the rule is the union of its conjunctions (`splits`), one for each choice of a
 * rule of every union it reads, each reading every other import again, the product of the unions' widths, so a rule
 * over two reads of a union of three rules is nine conjunctions, each reading the union's relations twice
 * (test/unit/physical/judge-size). Each rule of a union is navigated as a query of its own, so an import its rules
 * each read is read once in each of them. An import of one rule read once, or one that reads one relation alone, is
 * inlined, its reads keyed by the values the steps before them bound. The imports are counted in the unfolding as
 * inlining leaves it: a read inside an import navigation keeps whole is that import's own, so the shallowest imports
 * read more than once are kept first, and the rest counted again without the rows they hold. An import of one rule
 * whose head evaluates a declared function's call is one wherever it is read (ir/expr.ts evaluatesCall): read whole, its
 * call is evaluated over its own rows, a set, once per row, where inlined it stood in the reader's head and ran again
 * for every row the reader joins to one of the import's: edullm's stored walk of a package's patterns compiled each of
 * a package's 63 pattern texts once for each of the 469,935 elements that write one. A write member's navigation
 * (`perRead`) keeps its unions alone and inlines every import of one rule at every read, its steps keyed by the steps
 * before them.
 */
const sharedImports = (
	rules: ReadonlyArray<InferredRule>,
	interned: Navigation,
	sharing: ImportSharing
): KeptImports => {
	const shared = new Set<string>()
	const unions = new Set<string>()
	for (;;) {
		const counts = new Map<
			string,
			{ readonly n: number; readonly depth: number; readonly rule: InferredRule }
		>()
		let next = 0
		const visit = (
			r: InferredRule,
			toTop: (e: InferredExpr) => InferredExpr,
			depth: number
		): void => {
			for (const m of r.matches) {
				const source = m.source
				const binds = source.kind === "query" ? scalarBinds(source.bind) : undefined
				const stage = source.kind === "query" ? source.query.stage : undefined
				if (source.kind !== "query" || binds === undefined || stage?.kind !== "rules") {
					continue
				}
				const top = new Map([...binds].map(([name, e]) => [name, toTop(e)] as const))
				const key = interned.importKey(source.query, top)
				if (stage.arms.length > 1) {
					unions.add(key)
					continue
				}
				if (sharing.kind === "perStatement" && callsOf(stage.arms[0].head).size > 0) {
					shared.add(key)
					continue
				}
				const seen = counts.get(key)
				counts.set(key, {
					n: (seen?.n ?? 0) + 1,
					depth: Math.min(seen?.depth ?? depth, depth),
					rule: stage.arms[0]
				})
				if (shared.has(key)) {
					continue
				}
				const prefix = `c${next++}.`
				const leaves = { var: (id: string) => varRef(`${prefix}${id}`), field: () => undefined }
				visit(stage.arms[0], (e) => toTop(boundIn(mapLeaves(e, leaves), binds)), depth + 1)
			}
		}
		for (const rule of rules) {
			visit(rule, (e) => e, 0)
		}
		const joined =
			sharing.kind === "perRead"
				? []
				: [...counts].flatMap(([key, c]) => {
						const reads = c.n > 1 && !shared.has(key) ? interned.reads(c.rule).one : undefined
						return reads !== undefined && reads > 1 ? [{ key, depth: c.depth }] : []
					})
		if (!isNonEmpty(joined)) {
			return new Set([...shared, ...unions])
		}
		const shallowest = joined.reduce((least, c) => Math.min(least, c.depth), joined[0].depth)
		for (const c of joined) {
			if (c.depth === shallowest) {
				shared.add(c.key)
			}
		}
	}
}

/**
 * A conjunctive rule over stored and closed relations, as navigation reads it: its region, the deltas it matches, which
 * the chain reads before any relation, and its reads of relations.
 */
interface Flat {
	readonly vars: ReadonlyArray<VarDesc>
	readonly region: ReadonlyArray<Read>
	readonly reads: ReadonlyArray<Read>
	/**
	 * Its reads of an aggregating rule's groups (`foldsIn`), never inlined: each is a step of its own, the rule restricted
	 * inside to the group fields the steps before it bound (`#chain`).
	 */
	readonly grouped: ReadonlyArray<Grouped>
	readonly where: ReadonlyArray<InferredExpr>
	readonly head: InferredRule["head"]
}

/** A read of an aggregating rule's groups (Flat `grouped`): an import of the one rule, its bindings over the rule's
 * variables. */
interface Grouped {
	readonly source: Imported
	readonly bindings: InferredBindings
	readonly loc: SourceLoc
}

/**
 * The fields at which an import of one aggregating rule holds one fact each, its group fields, the head fields no
 * aggregate derives; undefined for any other source. Its facts are its body's folded at each group, so navigation never
 * inlines it, nor distributes a union its body reads into its reader's conjunctions: a fold over a union is no union
 * of folds, two arms' facts of one group folded apart would be two facts of the group.
 */
const foldsIn = (source: InferredSource): ReadonlyArray<string> | undefined => {
	if (source.kind !== "query" || source.query.stage.kind !== "rules") {
		return undefined
	}
	const [rule, ...more] = source.query.stage.arms
	return more.length === 0 && Object.values(rule.head).some((h) => h.kind === "aggregate")
		? Object.entries(rule.head).flatMap(([field, h]) => (h.kind === "aggregate" ? [] : [field]))
		: undefined
}

/**
 * Whether `rule` is more than one conjunction: it matches an import of several rules, or of one rule that is in turn,
 * at any depth, so it is the union of one conjunction for each choice of a rule at every union it reads, which
 * navigation never builds (`RuleReads`): it keeps each such import whole (`sharedImports`).
 */
const splits = (rule: InferredRule): boolean => rule.matches.some((m) => splitsAt(m.source))

/**
 * Whether a match of `source` makes its rule more than one conjunction (`splits`): an import of several rules, or of
 * one rule that splits in turn, but never of an aggregating rule (`foldsIn`), whose body's union its folds read whole.
 */
const splitsAt = (source: InferredSource): boolean =>
	source.kind === "query" &&
	source.query.stage.kind === "rules" &&
	foldsIn(source) === undefined &&
	(source.query.stage.arms.length > 1 || source.query.stage.arms.some(splits))

/** A relational filter of a rule, a negation or an existence, navigated apart (`Navigator.#filtered`). */
type Filtered = Extract<InferredExpr, { readonly kind: "absent" | "exists" }>

/** Whether `e` is a relational filter (`Filtered`). */
const isFiltered = (e: InferredExpr): e is Filtered => e.kind === "absent" || e.kind === "exists"

/** A rule's reads as one chain of steps (`Navigator.#chain`): the rule's parts, its relational filters still to navigate. */
interface Chain {
	readonly vars: ReadonlyArray<VarDesc>
	readonly matches: ReadonlyArray<InferredMatch>
	readonly where: ReadonlyArray<InferredExpr>
	readonly filters: ReadonlyArray<Filtered>
	readonly head: InferredRule["head"]
}

/**
 * What a step passes in, at nesting `depth`: each variable of its reader a channel bound to it, each parameter of the
 * reader a parameter of the same name, bound to itself.
 */
class Passing {
	readonly bind = new Map<string, InferredExpr>()
	readonly #depth: number
	/** Each variable passed in, by the place of its channel: the order the step first reads it in. */
	readonly #places = new Map<string, number>()

	constructor(depth: number) {
		this.#depth = depth
	}

	/**
	 * The channel the reader's variable `id` is passed in under, named by its place, never the variable's name: a step
	 * built alike under readers whose variables are named apart is one sub-query, which a lowering computes once for
	 * every reader (lower/shapes/share/copies.ts), where named by the variable a rule reading the limits at its `stage`
	 * and one reading them at its `resumed` sitting each read a copy of their own.
	 */
	channel(id: string): InferredExpr {
		const name = `via${this.#depth}.${this.#places.getOrInsertComputed(id, () => this.#places.size)}`
		this.bind.set(name, varRef(id))
		return { kind: "param", name, type: channel }
	}

	/** `e` passed in whole: every variable a channel, every parameter itself. */
	expr(e: InferredExpr): InferredExpr {
		return this.within(e, () => false)
	}

	/** `e` passed in but for the variables `own` holds, the step's own. */
	within(e: InferredExpr, own: (id: string) => boolean): InferredExpr {
		for (const p of leavesOf(e).params) {
			if (p.kind === "param") {
				this.bind.set(p.name, p)
			}
		}
		return mapLeaves(e, {
			var: (id) => (own(id) ? undefined : this.channel(id)),
			field: () => undefined
		})
	}
}

/** The equalities among `conditions`, each its two sides. */
const equalitiesOf = (
	conditions: ReadonlyArray<InferredExpr>
): ReadonlyArray<{ readonly left: InferredExpr; readonly right: InferredExpr }> =>
	conditions.flatMap((c) =>
		c.kind === "compare" && c.op === "eq" ? [{ left: c.left, right: c.right }] : []
	)

/**
 * The term `held` admits that each variable of `conditions` is equated with, through any chain of their equalities
 * between variables: of the class those equalities join a variable into, the first term in the conditions' order that a
 * variable of it is equated with directly and `held` admits, else the first variable of it `held` admits. A rule's
 * conditions are a conjunction, so every variable of a class holds the one value. Navigation reads this closure, never
 * the direct equalities alone (`fixedTerms`, `implied`): a key's channel or a literal an import's head is equated with
 * reaches the import's own variables through the head's equalities, which inlining the import states (Navigator
 * `#inline`).
 */
const equatedWith = (
	conditions: ReadonlyArray<InferredExpr>,
	held: (e: InferredExpr) => boolean
): ((id: string) => InferredExpr | undefined) =>
	equalityClosure(
		equalitiesOf(conditions).map(({ left, right }) => [left, right] as const),
		(e) => (e.kind === "var" ? e.var : undefined),
		held
	)

/**
 * The equalities of `conditions` their closure implies (`equatedWith`) between a variable and a term `known` holds: a
 * parameter, a channel, a typed literal, or a variable a step placed so far binds, for each variable equated with no
 * such term directly and not known itself. A read that binds such a variable is so looked up by it at its own step
 * (`#chain`, `fixed`), never equated with it at a later one: an import inlined into an arm of a definition read at a
 * written row's keys binds its relation's column to the arm's variable, which the arm equates with the key's channel,
 * so the column was the channel's two equalities away, and the read of the import's relation, placed first, took every
 * row of the other key columns, a learner's snapshots of every learner at one instant (the ledger's "Response in
 * time"), its predicate locks every learner's. A bare literal anchors nothing: it takes the type of the term it meets.
 */
const implied = (
	conditions: ReadonlyArray<InferredExpr>,
	known: (e: InferredExpr) => boolean
): ReadonlyArray<InferredExpr> => {
	const held = (e: InferredExpr): boolean => !isBare(e) && known(e)
	const anchorOf = equatedWith(conditions, held)
	const equalities = equalitiesOf(conditions)
	const direct = new Set(
		equalities.flatMap(({ left, right }) => [
			...(left.kind === "var" && held(right) ? [left.var] : []),
			...(right.kind === "var" && held(left) ? [right.var] : [])
		])
	)
	const vars = new Set(
		equalities.flatMap(({ left, right }) =>
			[left, right].flatMap((e) => (e.kind === "var" && !known(e) ? [e.var] : []))
		)
	)
	return [...vars].flatMap((id): ReadonlyArray<InferredExpr> => {
		const term = anchorOf(id)
		return direct.has(id) || term === undefined ? [] : [equal(varRef(id), term)]
	})
}

/** Navigates rules, `loc` locating a refusal. */
class Navigator {
	readonly #loc: SourceLoc
	readonly #columns: QueryColumns
	#next = 0

	readonly #sharing: ImportSharing

	readonly #interned: Navigation

	constructor(loc: SourceLoc, columns: QueryColumns, sharing: ImportSharing, interned: Navigation) {
		this.#interned = interned
		this.#sharing = sharing
		this.#loc = loc
		this.#columns = columns
	}

	#refuse(what: string): never {
		return refuse("MalformedDescription", this.#loc, `a navigation: ${what}`)
	}

	/**
	 * `rule` navigated at nesting `depth`: a chain of steps, then each of its relational filters, negations and
	 * existences, in declared order, over the rows the chain and the filters before it leave, each a chain of its own.
	 * Every rule but the last is a step the next reads whole, so PostgreSQL judges a filter only of a row every read and
	 * every earlier filter kept, and never reads a filtered relation for a row a read would have dropped.
	 *
	 * A filter that reads no variable, only the rule's parameters and literals, is a condition of the chain's own
	 * rule, as every condition that reads no variable is (`#chain`), all of them in declared order. PostgreSQL judges such
	 * a filter once, as a gating qual of a Result over the plan of the rule that holds it, before that plan reads a row
	 * (createplan.c:804-809, nodeResult.c:81-85), and the gating quals of one rule in declared order where their costs
	 * are equal (get_gating_quals, createplan.c:1007, through order_qual_clauses, a stable sort). Nested as a correlated
	 * negation is, the last would gate the outermost Result and be judged first, reading a later arm's relations for a
	 * row an earlier arm already refutes.
	 */
	rule(
		rule: InferredRule,
		depth: number,
		imports: KeptImports
	): NonEmptyReadonlyArray<InferredRule> {
		const whole = new Set(imports)
		const within = (): ReturnType<typeof sharedWithin> =>
			sharedWithin(
				this.#defined(this.#inline(rule, whole, (e) => e)),
				this.#loc,
				this.#columns,
				this.#sharing,
				this.#interned
			)
		let read = within()
		while (read.unrestricted.size > 0) {
			for (const key of read.unrestricted) {
				whole.delete(key)
			}
			read = within()
		}
		return [
			this.#filteredAfter(
				this.#chain(read.flat, depth, read.partnered),
				depth,
				pinnedBy(flatFixed(read.flat, rule.loc)),
				rule.loc
			)
		]
	}

	/**
	 * `rule`, whose matches navigation reads as they stand, a chain of steps already (`overSteps`): a probe's rows over
	 * its region (analysis/theory/query.ts overRegion) and the meeting part over them, which navigation reads no
	 * further (`RuleReads`), with each of its relational filters a chain of its own after them (`#filteredAfter`), as
	 * after any chain. As written, a filter of the side its rows meet, a containment's target that negates, was the
	 * target's join PostgreSQL planned by its estimates, and a negation whose binding computes over a variable of the
	 * filtered query, a guarded cast an inlined definition's head left, reached the checker, which lowers no computed
	 * binding of a negation (check/checker.ts #negatedTerm), where navigated it is a condition of the filter's own step.
	 * A filter navigation reads no part of (`#readable`) stays the rule's condition as written, as after a chain
	 * (`#chain` `asWritten`): a negation of an import whose rule reads a call's rows or a text's split, which a stored
	 * relation's upkeep and a whole rule read per unit over the steps their imports' joins navigate to, edullm's WalkFloat
	 * negating its tolerance's third token, was refused as no navigation where navigated.
	 */
	filteredOverSteps(rule: InferredRule, depth: number): InferredRule {
		const filters = rule.where.filter(isFiltered).filter((a) => this.#readable(a))
		return filters.length === 0
			? rule
			: this.#filteredAfter(
					{
						vars: rule.vars,
						matches: rule.matches,
						where: rule.where.filter((w) => !isFiltered(w) || !this.#readable(w)),
						filters,
						head: rule.head
					},
					depth,
					pinnedBy(fixedTerms(rule)),
					rule.loc
				)
	}

	/**
	 * Whether navigation reads a relational filter's source (`#filtered`): a stored or closed relation, or an imported
	 * query of rules binding no parameter each of which, as the filter reads it (`filteredArm`), navigation reads
	 * (`RuleReads`) and whose head holds each field the filter binds as a term of its matches (`equatedAt`), which the
	 * filter's step equates with its outer value. Any other filter stays the chain's condition as written (`#chain`): a
	 * whole rule's read of a recursion per unit (analysis/theory/unit.ts readPerUnit), whose filter imports the recursion
	 * whole, and a filter binding a fold its arm computes, as a negation of N0's greatest key at its folded field, a
	 * successor navigation reads by its one descent (Navigation `successorFold`, 1beed3dbb3), which the arm's whole body
	 * computes and no step restricted at the filter's terms reads, so navigating it was a refusal (`#filtered`).
	 */
	#readable(a: Filtered): boolean {
		const source = a.source
		switch (source.kind) {
			case "relation":
				return true
			case "query":
				return (
					Object.keys(source.bind).length === 0 &&
					source.query.stage.kind === "rules" &&
					source.query.stage.arms.every((written) => {
						const arm = filteredArm(written, a.bindings)
						return (
							Object.keys(a.bindings).every((field) => equatedAt(arm, field) !== undefined) &&
							this.#interned.reads(arm).every !== undefined
						)
					})
				)
			case "step":
			case "param":
			case "paramOf":
			case "call":
			case "callField":
			case "arm":
			case "split":
			case "series":
			case "interior":
			case "self":
			case "delta":
			case "context":
			case "row":
				return false
		}
	}

	/**
	 * The rule of `chain`'s reads and conditions, then each of its relational filters, negations and existences, in
	 * declared order, over the rows the chain and the filters before it leave, each a chain of its own (`rule`), `pinned`
	 * passing a filter the terms the chain's conditions fix.
	 */
	#filteredAfter(
		chain: Chain,
		depth: number,
		pinned: (e: InferredExpr) => InferredExpr,
		loc: SourceLoc
	): InferredRule {
		const kept = Object.fromEntries(chain.vars.map((v, i) => [`k${i}`, varRef(v.id)] as const))
		const gates = chain.filters.filter(readsNoVariable)
		let current: InferredRule = {
			vars: chain.vars,
			matches: chain.matches,
			where: [...chain.where, ...gates.map((a) => this.#filtered(a, depth, pinned))],
			head: kept,
			interiors: [],
			attach: [],
			loc
		}
		for (const a of chain.filters.filter((x) => !readsNoVariable(x))) {
			const passed = new Map(
				ruleLeaves(current, true).params.flatMap((p) =>
					p.kind === "param" ? [[p.name, p] as const] : []
				)
			)
			current = {
				vars: chain.vars,
				matches: [
					{
						source: {
							kind: "step",
							query: { stage: { kind: "rules", arms: [current], loc } },
							bind: Object.fromEntries(passed)
						},
						bindings: kept,
						loc
					}
				],
				where: [this.#filtered(a, depth, pinned)],
				head: kept,
				interiors: [],
				attach: [],
				loc
			}
		}
		return { ...current, head: chain.head }
	}

	/**
	 * `rule` with every imported query it matches inlined: its one rule's variables under a fresh prefix, its matches and
	 * conditions beside the rule's, and each term the match binds equated with the head field it binds; but an import of
	 * `shared` (`sharedImports`), by its key under `toTop`, which lifts a term of `rule` into the outermost rule's
	 * scope: that import is one read, of its query navigated as a query of its own, which every read of it shares.
	 *
	 * A match binds a variable at each field it binds to one, and where the field's equality is no identity (ir/scalar.ts
	 * equalityIsIdentity, a float's) a merge reads that binding (check/merge.ts regionMatches): so the import's head
	 * variable at such a field is that variable itself, inlined (`renamedAt`), each read of the import's rule that binds it
	 * binding the rule's variable in its place, where an equality between the two would bind it nowhere and the rule would
	 * deliver the -0 another read held where the written rule delivers +0. An import whose binding renaming cannot keep is
	 * read whole, as written: a head term that is no variable, or a variable no read of its rule binds or that the match
	 * binds at two variables.
	 */
	#inline(
		rule: InferredRule,
		shared: ReadonlySet<string>,
		toTop: (e: InferredExpr) => InferredExpr
	): Flat {
		if (rule.interiors.length > 0 || rule.attach.length > 0) {
			return this.#refuse("a rule with interiors or attachments")
		}
		const vars: Array<VarDesc> = [...rule.vars]
		const region: Array<Read> = []
		const reads: Array<Read> = []
		const grouped: Array<Grouped> = []
		const where: Array<InferredExpr> = [...rule.where]
		for (const m of rule.matches) {
			const source = m.source
			if (source.kind === "relation") {
				reads.push({ source, bindings: m.bindings, loc: m.loc })
				continue
			}
			if (source.kind === "delta") {
				region.push({ source, bindings: m.bindings, loc: m.loc })
				continue
			}
			const binds = source.kind === "query" ? scalarBinds(source.bind) : undefined
			if (source.kind !== "query" || binds === undefined) {
				return this.#refuse(`a match of a ${source.kind} source`)
			}
			if (foldsIn(source) !== undefined) {
				grouped.push({ source, bindings: m.bindings, loc: m.loc })
				continue
			}
			const top = new Map([...binds].map(([name, e]) => [name, toTop(e)] as const))
			if (shared.has(this.#interned.importKey(source.query, top))) {
				reads.push({ source, bindings: m.bindings, loc: m.loc })
				continue
			}
			const stage = source.query.stage
			if (stage.kind !== "rules" || stage.arms.length !== 1) {
				return this.#refuse("an imported query of one rule")
			}
			const prefix = `n${this.#next++}.`
			/** The import's head variables bound to the rule's own, each by its rule variable (`renamedAt`). */
			let renamed: ReadonlyMap<string, string> = new Map()
			const leaves = {
				var: (id: string) => varRef(renamed.get(id) ?? `${prefix}${id}`),
				field: () => undefined
			}
			/** An inner expression in the rule's scope: its variables renamed apart, its parameters what the import binds. */
			const lift = (e: InferredExpr): InferredExpr => boundIn(mapLeaves(e, leaves), binds)
			const inner = this.#inline(stage.arms[0], shared, (e) => toTop(lift(e)))
			const kept = this.#renamedAt(rule, m, inner)
			if (kept === undefined) {
				reads.push({ source, bindings: m.bindings, loc: m.loc })
				continue
			}
			renamed = kept
			appendAll(
				vars,
				inner.vars.flatMap((v) => (renamed.has(v.id) ? [] : [{ ...v, id: `${prefix}${v.id}` }]))
			)
			const lifted = (r: Read): Read => ({
				...r,
				source:
					r.source.kind === "query"
						? {
								...r.source,
								bind: mapBindMap(r.source.bind, lift)
							}
						: r.source,
				bindings: Object.fromEntries(
					Object.entries(r.bindings).map(([column, e]) => [column, lift(e)] as const)
				)
			})
			appendAll(region, inner.region.map(lifted))
			appendAll(reads, inner.reads.map(lifted))
			appendAll(
				grouped,
				inner.grouped.map((g) => ({
					...g,
					source: { ...g.source, bind: mapBindMap(g.source.bind, lift) },
					bindings: Object.fromEntries(
						Object.entries(g.bindings).map(([column, e]) => [column, lift(e)] as const)
					)
				}))
			)
			appendAll(where, inner.where.map(lift))
			const columns = this.#columns.desc(source.query)
			for (const [field, outer] of Object.entries(m.bindings)) {
				const head = inner.head[field]
				if (head === undefined || head.kind === "aggregate" || head.kind === "producer") {
					return this.#refuse(`an imported query whose head derives ${field}`)
				}
				if (head.kind !== "var" || outer.kind !== "var" || renamed.get(head.var) !== outer.var) {
					where.push(equal(lift(atColumn(head, field, columns)), atColumn(outer, field, columns)))
				}
			}
		}
		return { vars, region, reads, grouped, where, head: rule.head }
	}

	/**
	 * The head variables of `inner`, the inlined rule of `rule`'s match `m`, that are `rule`'s own variables (#inline),
	 * each by that variable: those delivered at the fields `m` binds to a variable the written rule binds at two columns
	 * or more, `m`'s fields and other matches' (check/merge.ts regionMatches), where the column's type's equality is no
	 * identity, so the inlined rule binds it at two reads or more too and a merge reads it as the written rule's does. A
	 * variable bound at one column is one read's value as written, whatever navigation makes of the import. Undefined
	 * where renaming cannot keep the variable bound twice, so the import is read whole: a field's head term is no
	 * variable, or a variable no read of `inner` binds, or one `m` binds at two variables, or the renamed variables'
	 * reads and the other matches bind it once. Another match's column types the variable, the import's heading only
	 * where no other match binds it, each off the schema (`sourceType`, `identityAt`), a column it cannot type of none.
	 */
	#renamedAt(
		rule: InferredRule,
		m: InferredMatch,
		inner: Flat
	): ReadonlyMap<string, string> | undefined {
		const source = m.source
		if (source.kind !== "query") {
			return new Map()
		}
		/** How many columns the reads of `inner` bind variable `id` at. */
		const innerBinders = (id: string): number =>
			[...inner.reads, ...inner.region, ...inner.grouped].reduce(
				(n, r) =>
					n + Object.values(r.bindings).filter((e) => e.kind === "var" && e.var === id).length,
				0
			)
		/** Each column a match of `rule` other than `m` binds variable `id` at, with whether its equality is identity. */
		const elsewhere = (id: string): ReadonlyArray<() => boolean> =>
			rule.matches.flatMap((n) => {
				const at = n.source
				if (n === m) {
					return []
				}
				return Object.entries(n.bindings).flatMap(([column, e]) =>
					e.kind === "var" && e.var === id ? [() => identityAt(this.#columns, at, column)] : []
				)
			})
		const fieldsOf = Map.groupBy(
			Object.entries(m.bindings).flatMap(([field, e]) =>
				e.kind === "var" ? [[e.var, field] as const] : []
			),
			([id]) => id
		)
		const renamed = new Map<string, string>()
		for (const [id, bound] of fieldsOf) {
			const fields = bound.map(([, field]) => field)
			const other = elsewhere(id)
			const [first] = fields
			const identity =
				other[0] ??
				(first === undefined ? undefined : () => identityAt(this.#columns, source, first))
			if (other.length + fields.length < 2 || identity === undefined || identity()) {
				continue
			}
			const heads = new Set<string>()
			for (const field of fields) {
				const head = inner.head[field]
				if (head?.kind !== "var" || innerBinders(head.var) === 0) {
					return undefined
				}
				const prior = renamed.get(head.var)
				if (prior !== undefined && prior !== id) {
					return undefined
				}
				renamed.set(head.var, id)
				heads.add(head.var)
			}
			if (other.length + [...heads].reduce((n, h) => n + innerBinders(h), 0) < 2) {
				return undefined
			}
		}
		return renamed
	}

	/**
	 * `flat` with every variable no read binds replaced by the term an equality equates it with, and that equality
	 * dropped: what an inlined import's head equated with a term only the import's match bound. A bare literal, which has
	 * no type of its own and takes the type of the term it meets, defines no variable, so a condition the rule states of
	 * a variable at a literal, `kind = 1`, stays a condition of the term that defines it; the equations `#inline` states
	 * hold no bare literal (leaves.ts atColumn), so every such variable has a term to be defined by. A variable a read binds
	 * stays the read's own, so every relational filter and the head still read the row the chain delivers. Every variable left is
	 * one a read binds.
	 */
	#defined(flat: Flat): Flat {
		const bound = new Set(
			[...flat.region, ...flat.reads, ...flat.grouped].flatMap((r) =>
				Object.values(r.bindings).flatMap((e) => [...readsOf(e)])
			)
		)
		const defines = (v: InferredExpr, term: InferredExpr): string | undefined => {
			if (v.kind !== "var" || isBare(term) || readsOf(term).has(v.var)) {
				return undefined
			}
			return bound.has(v.var) ? undefined : v.var
		}
		for (const [at, w] of flat.where.entries()) {
			if (w.kind !== "compare" || w.op !== "eq") {
				continue
			}
			const left = defines(w.left, w.right)
			const right = left === undefined ? defines(w.right, w.left) : undefined
			const name = left ?? right
			if (name === undefined) {
				continue
			}
			const term = left === undefined ? w.left : w.right
			const leaves = {
				var: (id: string) => (id === name ? term : undefined),
				field: () => undefined
			}
			return this.#defined({
				vars: flat.vars.filter((v) => v.id !== name),
				region: flat.region.map((r) => ({ ...r, bindings: mapBindings(r.bindings, leaves) })),
				reads: flat.reads.map((r) => ({ ...r, bindings: mapBindings(r.bindings, leaves) })),
				grouped: flat.grouped.map((g) => ({ ...g, bindings: mapBindings(g.bindings, leaves) })),
				where: flat.where.flatMap((x, i) => (i === at ? [] : [mapLeaves(x, leaves)])),
				head: Object.fromEntries(
					Object.entries(flat.head).map(([k, h]) => [
						k,
						h.kind === "aggregate" || h.kind === "producer" ? h : mapLeaves(h, leaves)
					])
				)
			})
		}
		const unbound = flat.vars.find((v) => !bound.has(v.id))
		return unbound === undefined ? flat : this.#refuse(`variable ${unbound.id} bound by no match`)
	}

	/**
	 * The reads of `flat` as one chain of steps, at nesting `depth`: its region first, the rows a transaction wrote that a
	 * rule probe over its region starts from (analysis/theory/query.ts probe), then its reads of relations in their
	 * order (module doc). Each condition is placed inside the first step after which every variable it reads is bound; a
	 * condition no variable of which a step binds stays the rule's own; the relational filters are left to `rule`.
	 *
	 * Each import the rule reads whole (`sharedWithin`) is a match of the rule itself, never a step (`matchWhole`): every
	 * read of it is an occurrence of one region, so the checker builds it once for all of them (check/checker.ts
	 * #imported) and the lowering computes it once per row of what binds its parameters, the unit's channels, a join of
	 * its rows at each read (lower/optimize/cte-policy), where a step of its own at each read would be a node of its own,
	 * correlated to that step's region. One a parameter restricts stands before the steps, its variables bound from then
	 * on, so the chain's steps read by them. One no parameter restricts over the units (`partnered`) is placed among the
	 * steps by their order, once the steps before it have bound what they bind of its columns: those steps are the
	 * partners that restrict its rows at each read. Placed before every step, it bound the variables the steps after it
	 * were keyed by, so no step restricted it, and the lowering computed it whole: metis's judge of a first budget, over
	 * the delta of an assignment, read every document's timing scopes, a union over the content alone that each read
	 * joined at the package and path its sitting's test content bound, and every rate-paced assignment, at each COMMIT.
	 */
	#chain(flat: Flat, depth: number, partnered: ReadonlySet<Read>): Chain {
		const declared = new Map(flat.vars.map((v) => [v.id, v] as const))
		const known = new Set<string>()
		let reads: ReadonlyArray<Read> = [
			...flat.reads.filter((r) => r.source.kind !== "query" || partnered.has(r)),
			...flat.grouped
		]
		let pending: Array<InferredExpr> = []
		const filters: Array<Filtered> = []
		/** The relational filters navigation does not read (`#readable`): each the rule's own condition, as written. */
		const asWritten: Array<Filtered> = []
		const head = flat.head
		const where: Array<InferredExpr> = []
		for (const c of flat.where) {
			if (isFiltered(c)) {
				;(this.#readable(c) ? filters : asWritten).push(c)
			} else if (readsOf(c).size === 0) {
				where.push(c)
			} else {
				pending.push(c)
			}
		}
		const isKnown = (e: InferredExpr): boolean => [...readsOf(e)].every((id) => known.has(id))
		const others = (r: Read): ReadonlyArray<{ readonly bindings: InferredBindings }> =>
			[...flat.region, ...flat.reads, ...flat.grouped].filter((o) => o !== r)
		/**
		 * The successor read `r` is where `bound` holds of a variable (analysis/theory/successor.ts): the one row of its
		 * relation the head's fold reads, past the cut, which its step reads by one descent of its key's order.
		 */
		const successorWhere = (r: Read, bound: (variable: string) => boolean): Successor | undefined =>
			successorOf(
				r.bindings,
				this.#interned.keysOf(r.source),
				{
					head,
					conditions: flat.where,
					beside: others(r).flatMap((o) => Object.values(o.bindings))
				},
				bound
			)
		/** The successor read `r` is from the values known so far. */
		const successorAt = (r: Read): Successor | undefined => successorWhere(r, (v) => known.has(v))
		/**
		 * Whether `r` is a successor read only once the reads beside it are placed, its cut or its key's other fields
		 * bound by them, and not yet: it waits for them, so the probe admission claims of it (unit.ts ruleClosure) is
		 * the step navigation reads it by, whichever match the rule states first.
		 */
		const waiting = (r: Read): boolean => {
			const beside = new Set(
				others(r).flatMap((o) => Object.values(o.bindings).flatMap((e) => [...readsOf(e)]))
			)
			return (
				successorAt(r) === undefined &&
				successorWhere(r, (v) => known.has(v) || beside.has(v)) !== undefined
			)
		}
		/**
		 * The variables an equality still pending fixes to values the steps placed so far hold, each with whether one
		 * such value is keyed (`keyedTerm`).
		 */
		const fixed = (): ReadonlyMap<string, boolean> => {
			const out = new Map<string, boolean>()
			for (const c of pending) {
				if (c.kind === "compare" && c.op === "eq") {
					for (const [side, term] of [
						[c.left, c.right],
						[c.right, c.left]
					] as const) {
						const v = relabeled(side)
						if (v.kind === "var" && isKnown(term)) {
							out.set(v.var, out.get(v.var) === true || keyedTerm(term))
						}
					}
				}
			}
			return out
		}
		/**
		 * The variables a suffix test still pending seeks by a suffix the steps placed so far hold, keyed
		 * (`suffixTestOf`, `keyedTerm`).
		 */
		const sought = (): ReadonlySet<string> =>
			new Set(
				pending.flatMap((c) => {
					const test = suffixTestOf(c)
					return test !== undefined &&
						!known.has(test.subject) &&
						isKnown(test.suffix) &&
						keyedTerm(test.suffix)
						? [test.subject]
						: []
				})
			)
		/**
		 * How a read is looked up from the values known so far (`Lookup`): a column bound to a variable a suffix test seeks
		 * is keyed, a seek of the B-tree on its suffix key.
		 */
		const lookupOf = (
			r: Read,
			values: ReadonlyMap<string, boolean>,
			seeks: ReadonlySet<string>
		): Lookup => {
			const keyed = new Set<string>()
			const bound = new Set<string>()
			const keys = foldsIn(r.source)
			for (const [column, e] of Object.entries(r.bindings)) {
				if (keys !== undefined && !keys.includes(column)) {
					continue
				}
				const ids = [...readsOf(e)]
				if (ids.every((id) => known.has(id) || values.has(id))) {
					bound.add(column)
					if (
						leavesOf(e).params.length > 0 ||
						ids.some((id) => known.has(id) || values.get(id) === true)
					) {
						keyed.add(column)
					}
				} else if (e.kind === "var" && seeks.has(e.var)) {
					keyed.add(column)
				}
			}
			return { read: r, keyed, bound }
		}
		/**
		 * Whether read `r` reads every row of its relation: each of its columns bound to a variable of its own, at that
		 * column alone, which no step placed, no equality still pending fixes (`values`) and no suffix test seeks
		 * (`seeks`), and no condition still pending reads its variables alone, with values the steps placed. A read a
		 * literal, a value or a condition of its own restricts may hold fewer rows than a read contained in its relation:
		 * qti's `q` elements are few, the first children of every node many.
		 */
		const readsAll = (
			r: Read,
			values: ReadonlyMap<string, boolean>,
			seeks: ReadonlySet<string>
		): boolean => {
			const own = new Set<string>()
			for (const e of Object.values(r.bindings)) {
				if (
					e.kind !== "var" ||
					own.has(e.var) ||
					known.has(e.var) ||
					values.has(e.var) ||
					seeks.has(e.var)
				) {
					return false
				}
				own.add(e.var)
			}
			return pending.every((c) => ![...readsOf(c)].every((id) => own.has(id) || known.has(id)))
		}
		const vars: Array<VarDesc> = []
		const matches: Array<InferredMatch> = []
		/**
		 * The variable a read binds its column `column` to in place of the term `e`, which reads variables other matches
		 * bind (`place`): a hidden variable of the read's own, declared at the column, and its equality with the term
		 * pending, so the term's variables stay the matches' that bind them.
		 */
		const hiddenFor = (read: Read, column: string, e: InferredExpr): string => {
			const hidden = `h${this.#next++}.${column}`
			declared.set(hidden, { id: hidden, origin: originOf(read.source, column), loc: read.loc })
			pending.push(equal(varRef(hidden), e))
			return hidden
		}
		/**
		 * `read`, an import the rule reads whole, placed as the next match of the rule itself, its variables bound
		 * from then on. Its bindings are the variables its bare bindings name, a term over other matches' variables through
		 * a hidden variable (`hiddenFor`), never those a computed term reads. An equality still pending between one of the
		 * variables it binds first and one a step before it bound is the rule's own, a join of the region its occurrence
		 * stands in, through which those steps restrict it, never a condition of the next step's, inside which no reader of
		 * the region sees it.
		 */
		const matchWhole = (read: Read): void => {
			const bindings = mapRecord(read.bindings, (e, column) =>
				e.kind === "var" || readsOf(e).size === 0 ? e : varRef(hiddenFor(read, column, e))
			)
			matches.push({ source: read.source, bindings, loc: read.loc })
			const first = new Set<string>()
			for (const e of Object.values(bindings)) {
				for (const id of readsOf(e)) {
					if (known.has(id)) {
						continue
					}
					known.add(id)
					first.add(id)
					vars.push(declared.get(id) ?? this.#refuse(`a declaration of variable ${id}`))
				}
			}
			pending = pending.filter((c) => {
				const joins =
					c.kind === "compare" &&
					c.op === "eq" &&
					c.left.kind === "var" &&
					c.right.kind === "var" &&
					known.has(c.left.var) &&
					known.has(c.right.var) &&
					first.has(c.left.var) !== first.has(c.right.var)
				if (joins) {
					where.push(c)
				}
				return !joins
			})
		}
		for (const read of flat.reads) {
			if (read.source.kind === "query" && !partnered.has(read)) {
				matchWhole(read)
			}
		}
		/**
		 * `read` placed next: a step, its variables bound from then on, or an import its partners restrict (`matchWhole`).
		 * A known variable the step reads at a column whose equality is no identity (ir/scalar.ts equalityIsIdentity, a
		 * float's) is passed in and delivered again, bound to the variable, so the rule binds it at every match the
		 * written rule bound it at, and a merge delivers its canonical form as it does the written rule's (check/merge.ts
		 * regionMatches): bound at the step's input alone, the rule delivered the -0 one read held where the written rule
		 * delivered +0.
		 */
		const place = (read: Read): void => {
			if (partnered.has(read)) {
				matchWhole(read)
				return
			}
			const successor = successorAt(read)
			const passing = new Passing(depth)
			const own = new Set<string>()
			const bindings: Record<string, InferredExpr> = {}
			/**
			 * Each known variable the read binds at a column whose equality is no identity, with the channel it is passed in,
			 * which the step delivers again, bound to the variable, so the rule binds it at every match that bound it.
			 */
			const rebound = new Map<string, InferredExpr>()
			for (const [column, e] of Object.entries(read.bindings)) {
				if (isKnown(e)) {
					const passed = passing.expr(e)
					bindings[column] = passed
					if (
						e.kind === "var" &&
						!rebound.has(e.var) &&
						!identityAt(this.#columns, read.source, column)
					) {
						rebound.set(e.var, passed)
					}
				} else if (e.kind === "var") {
					own.add(e.var)
					bindings[column] = e
				} else {
					const hidden = hiddenFor(read, column, e)
					own.add(hidden)
					bindings[column] = varRef(hidden)
				}
			}
			const inner: Array<InferredExpr> = []
			pending = pending.filter((c) => {
				if ([...readsOf(c)].every((id) => known.has(id) || own.has(id))) {
					inner.push(passing.within(c, (id) => own.has(id)))
					return false
				}
				return true
			})
			const outputs = [...own]
			const stepVars = outputs.map(
				(id) => declared.get(id) ?? this.#refuse(`a declaration of variable ${id}`)
			)
			const delivered = Object.fromEntries(outputs.map((id, i) => [`o${i}`, varRef(id)] as const))
			const again = [...rebound].map(([id, passed], i) => ({
				column: `o${outputs.length + i}`,
				id,
				passed
			}))
			const source: ReadSource =
				read.source.kind === "query"
					? { ...read.source, bind: mapBindMap(read.source.bind, (e) => passing.expr(e)) }
					: read.source
			const stepRule: InferredRule = {
				vars: stepVars,
				matches: [{ source, bindings, loc: read.loc }],
				where: inner,
				head: {
					...delivered,
					...Object.fromEntries(again.map((a) => [a.column, a.passed] as const))
				},
				interiors: [],
				attach: [],
				loc: read.loc
			}
			const rules: InferredQuery["stage"] = {
				kind: "rules",
				arms: [source.kind === "query" ? this.#grouped(stepRule, source, bindings) : stepRule],
				loc: read.loc
			}
			/** A successor's step reads its relation's first row past the cut in its key's order, one descent. */
			const step: InferredSource = {
				kind: "step",
				query: {
					stage:
						successor === undefined
							? rules
							: {
									kind: "take",
									input: {
										kind: "order",
										input: rules,
										order: [
											{ column: `o${outputs.indexOf(successor.variable)}`, dir: successor.dir }
										],
										loc: read.loc
									},
									take: { kind: "literal", k: 1 },
									loc: read.loc
								}
				},
				bind: Object.fromEntries(passing.bind)
			}
			matches.push({
				source: step,
				bindings: {
					...delivered,
					...Object.fromEntries(again.map((a) => [a.column, varRef(a.id)] as const))
				},
				loc: read.loc
			})
			appendAll(vars, stepVars)
			for (const id of outputs) {
				known.add(id)
			}
		}
		for (const read of flat.region) {
			place(read)
		}
		while (reads.length > 0) {
			appendAll(pending, implied(pending, isKnown))
			const values = fixed()
			const seeks = sought()
			const ready = reads.some((r) => !waiting(r))
			let best = reads.findIndex((r) => !ready || !waiting(r))
			for (const [i, r] of reads.entries()) {
				const current = reads[best]
				if (current === undefined || (ready && waiting(r))) {
					continue
				}
				const at = lookupOf(r, values, seeks)
				const held = lookupOf(current, values, seeks)
				if (
					this.#interned.narrower(at, held) ||
					(!this.#interned.narrower(held, at) &&
						this.#interned.within(r, current) &&
						readsAll(current, values, seeks))
				) {
					best = i
				}
			}
			const read = reads[best]
			if (read === undefined) {
				return this.#refuse("a read to place")
			}
			reads = reads.filter((_, i) => i !== best)
			place(read)
		}
		const left = pending.filter((c) => !isKnown(c))
		if (left.length > 0) {
			return this.#refuse("a condition over variables no read binds")
		}
		return { vars, matches, where: [...where, ...pending, ...asWritten], filters, head }
	}

	/**
	 * `m`, a match of an import navigation reads apart, restricted where it stands: each of its columns bound to a
	 * variable `bound` holds is equated inside each rule of the import with a parameter of its own (`boundInside`), which
	 * its bind map binds to that variable, and each the rule fixes (`fixed`, its fixedTerms) with that term, so the chain
	 * navigation builds for the import apart starts at a lookup at the reader's values, never a read of every row, and the
	 * import is correlated to the reader's row, read after the matches it reads, with no step of its own around it; one
	 * import for each set of its columns so bound, its identity the parameters' (Navigation `navigated`). Undefined where
	 * no column of it is bound to such a variable. `bound` is, for an import read as a chain of its own (`chainedApart`),
	 * what the matches navigation reads where they stand bind, and for one that passes rows through (`passesThrough`),
	 * what the call's own rows bind (navigatedRule `inputs`), which no import binds, so no import is correlated to another;
	 * none for one that computes apart, which the region's chain reads at the call's key set. The restriction crosses
	 * only the rule's matches, its positive conjunctive occurrences, never a relational filter. edullm's ledger finalize,
	 * the call's sittings beside SettledSitting, read every ended sitting's test_end row in a fenced step and refuted each
	 * by its pending attempts, 82,526 at 1x, for the call's one sitting; restricted, the chain starts at the call's
	 * sitting.
	 */
	restrictedApart(
		m: InferredMatch,
		source: Imported,
		bound: ReadonlySet<string>,
		fixed: (term: InferredExpr) => InferredExpr | undefined
	): InferredMatch | undefined {
		const passing = new Passing(0)
		const keyed = (e: InferredExpr): boolean => {
			const ids = readsOf(e)
			return ids.size > 0 && [...ids].every((id) => bound.has(id))
		}
		if (!Object.values(m.bindings).some(keyed)) {
			return undefined
		}
		const inside = boundInside(
			source,
			mapRecord(m.bindings, (e) => (keyed(e) ? passing.expr(e) : e)),
			(term) => (isFixed(term) ? term : fixed(term)),
			this.#columns
		)
		const bind = mapBindMap(inside.bind, (e) =>
			e.kind === "param" ? (passing.bind.get(e.name) ?? e) : e
		)
		return {
			...m,
			source: {
				...inside,
				bind,
				query: navigatedQuery(inside.query, this.#loc, this.#columns, this.#sharing, this.#interned)
			}
		}
	}

	/**
	 * The step `step` that reads an aggregating rule's groups, its one match `source` at `bindings` (Flat `grouped`): the
	 * rule restricted inside to each group field the steps before it fixed, a channel bound or a condition of the step
	 * equated with one (`fixedTerms`), its every relation then read by the group it folds (`boundInside`), and navigated
	 * as a query of its own (`navigatedQuery`), so the step folds the rows of the groups its reader reaches alone, never
	 * every group's. A folded field's binding stays the step's own, compared after the fold.
	 */
	#grouped(step: InferredRule, source: Imported, bindings: InferredBindings): InferredRule {
		const inside = boundInside(source, bindings, fixedTerms(step), this.#columns)
		const restricted: Imported = {
			...inside,
			query: navigatedQuery(inside.query, this.#loc, this.#columns, this.#sharing, this.#interned)
		}
		return { ...step, matches: [{ source: restricted, bindings, loc: step.loc }] }
	}

	/**
	 * A relational filter as a chain of its own, of its own kind, at nesting `depth` of the rule that filters: a filtered
	 * relation one step reading it by the terms it is filtered at, a filtered arm its rule navigated with its head
	 * equated with those terms, each passed in through the filter's channels.
	 */
	#filtered(a: Filtered, depth: number, pinned: (e: InferredExpr) => InferredExpr): InferredExpr {
		const passing = new Passing(depth)
		const source = a.source
		switch (source.kind) {
			case "relation": {
				const bindings = Object.fromEntries(
					Object.entries(a.bindings).map(
						([column, e]) => [column, passing.expr(pinned(e))] as const
					)
				)
				const step: InferredSource = {
					kind: "step",
					query: {
						stage: {
							kind: "rules",
							arms: [
								{
									vars: [],
									matches: [{ source, bindings, loc: this.#loc }],
									where: [],
									head: {},
									interiors: [],
									attach: [],
									loc: this.#loc
								}
							],
							loc: this.#loc
						}
					},
					bind: Object.fromEntries(passing.bind)
				}
				return { kind: a.kind, source: step, bindings: {} }
			}
			case "query": {
				const stage = source.query.stage
				if (Object.keys(source.bind).length > 0 || stage.kind !== "rules") {
					return this.#refuse("a filter of an imported query of rules binding no parameter")
				}
				const columns = this.#columns.desc(source.query)
				const arms = stage.arms
				const keptOf = (arm: InferredRule): KeptImports =>
					sharedImports([arm], this.#interned, this.#sharing)
				const navigated = flatMapNonEmpty(arms, (written) => {
					const arm = filteredArm(written, a.bindings)
					const at: Array<InferredExpr> = []
					for (const [field, outer] of Object.entries(a.bindings)) {
						const head = equatedAt(arm, field)
						if (head === undefined) {
							return this.#refuse(`a filtered query whose head derives ${field}`)
						}
						at.push(
							equal(
								atColumn(head, field, columns),
								passing.expr(atColumn(pinned(outer), field, columns))
							)
						)
					}
					return this.rule({ ...arm, where: [...arm.where, ...at] }, depth + 1, keptOf(arm))
				})
				return {
					kind: a.kind,
					source: {
						kind: "query",
						query: { stage: { kind: "rules", arms: navigated, loc: stage.loc } },
						bind: Object.fromEntries(passing.bind)
					},
					bindings: {}
				}
			}
			case "step":
			case "param":
			case "paramOf":
			case "call":
			case "callField":
			case "arm":
			case "split":
			case "series":
			case "interior":
			case "self":
			case "delta":
			case "context":
			case "row":
				return this.#refuse(`a filter of a ${source.kind} source`)
		}
	}
}

/**
 * The rule `rule` navigated (module doc): the same facts, read as one chain of steps from the values it holds, its
 * negations chains of their own. `loc` locates a refusal, which only a rule `navigateQuery` does not hand it meets.
 */
const navigate = (
	rule: InferredRule,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
	imports: KeptImports,
	interned: Navigation
): NonEmptyReadonlyArray<InferredRule> =>
	new Navigator(loc, columns, sharing, interned).rule(rule, 0, imports)

/** Whether a scalar condition holds a relational filter anywhere below its top, where navigation reads none (`RuleReads`). */
const filtersBelow = (e: InferredExpr): boolean =>
	isFiltered(e) || exprChildren(e).some((c) => filtersBelow(c.term))

/**
 * What navigation reads of a rule (`ruleReads`): `one`, the stored and closed relations and the deltas the rule reads
 * once its imports are inlined (`Navigator.#inline`), undefined where navigation reads no such rule: one with
 * interiors, attachments or a folded or produced head, a match of anything but a stored or closed relation, a delta or
 * an imported query of one such rule binding no parameter, a relational filter below a scalar expression, a filter of
 * anything but a stored or closed relation or an imported query. A filter, a negation or an existence, is no read the
 * count holds: it keeps or drops a row the reads deliver, so a rule that reads one relation beside a filter is one
 * lookup, and a filter of a delta, which no step reads by an index, leaves the rule as written, where PostgreSQL hashes
 * the delta once per statement. A filter of an imported query navigation does not read, one binding a parameter or
 * one of a rule navigation reads no part of (an aggregate's, at any depth), counts nothing either: it stays the rule's
 * condition as written (Navigator #chain `asWritten`), and the rule's reads are navigated all the same: it is applied
 * to the same rows after the chain as it was beside the reads as written, so the rule derives the same facts. It left the
 * whole rule as written, every relation it reads one flat join PostgreSQL ordered by its estimates: the ledger's key
 * of a limited test attempt, which negates the unlimited members, whose max-attempts in force negate an aggregating
 * rule's nearest scope, read every attempt and item session of every learner and joined the written test session's
 * (child, stage) last, a filter of 1,401,075 rows (metis's start, 24 s warm), and every test session of a package for
 * each of its attempts (edullm's answer and record, 1.5 s of 1.7 s at c1).
 *
 * And the same over the rule's conjunctions, never built: `most`, the most relations a conjunction navigation reads
 * reads, undefined where it reads none of them, and `every`, the most where it reads every one of them, undefined where
 * it reads some one not. A conjunction is a choice of one rule at each read of an import of several rules, at any
 * depth, each read's choice its own, so the most a conjunction reads is the sum of the most each read's rules read; and
 * `filtersJoin`, whether the rule filters by a query a conjunction of which joins (`someConjunctionJoins`), as every
 * conjunction of the rule filters as it does. Each import's rules are read once (Navigation `reads`), where its
 * conjunctions are the product of the unions' widths at every depth.
 */
interface RuleReads {
	readonly one: number | undefined
	readonly most: number | undefined
	readonly every: number | undefined
	readonly filtersJoin: boolean
}

/** A rule navigation reads no part of, nor any conjunction of (`RuleReads`). */
const unread: RuleReads = { one: undefined, most: undefined, every: undefined, filtersJoin: false }

/** The sum of two counts of reads, none where either is none. */
const plus = (a: number | undefined, b: number | undefined): number | undefined =>
	a === undefined || b === undefined ? undefined : a + b

/** The reads of `rule` (`RuleReads`), each rule of an import it matches or filters by read by `of`. */
const ruleReads = (rule: InferredRule, of: (rule: InferredRule) => RuleReads): RuleReads => {
	if (rule.interiors.length > 0 || rule.attach.length > 0) {
		return unread
	}
	if (Object.values(rule.head).some((h) => h.kind === "aggregate" || h.kind === "producer")) {
		return unread
	}
	let one: number | undefined = 0
	let most: number | undefined = 0
	let every: number | undefined = 0
	for (const m of rule.matches) {
		const source = m.source
		if (source.kind === "relation" || source.kind === "delta") {
			one = plus(one, 1)
			most = plus(most, 1)
			every = plus(every, 1)
			continue
		}
		if (
			source.kind !== "query" ||
			scalarBinds(source.bind) === undefined ||
			source.query.stage.kind !== "rules"
		) {
			return unread
		}
		if (foldsIn(source) !== undefined) {
			one = plus(one, 1)
			most = plus(most, 1)
			every = plus(every, 1)
			continue
		}
		const arms = mapNonEmpty(source.query.stage.arms, of)
		one = plus(one, arms.length === 1 ? arms[0].one : undefined)
		most = plus(
			most,
			arms.reduce<number | undefined>(
				(n, arm) => (arm.most === undefined ? n : Math.max(n ?? arm.most, arm.most)),
				undefined
			)
		)
		every = plus(
			every,
			arms.reduce<number | undefined>(
				(n, arm) =>
					n === undefined || arm.every === undefined ? undefined : Math.max(n, arm.every),
				0
			)
		)
	}
	let filtersJoin = false
	for (const w of rule.where) {
		if (!isFiltered(w)) {
			if (filtersBelow(w)) {
				return unread
			}
			continue
		}
		const source = w.source
		if (source.kind === "relation") {
			continue
		}
		if (source.kind !== "query") {
			return unread
		}
		if (Object.keys(source.bind).length > 0 || source.query.stage.kind !== "rules") {
			continue
		}
		const arms = mapNonEmpty(source.query.stage.arms, of)
		if (arms.some((arm) => arm.every === undefined)) {
			continue
		}
		filtersJoin ||= arms.some(someConjunctionJoins)
	}
	return { one, most, every, filtersJoin }
}

/**
 * Whether navigation reads a rule and it joins (`RuleReads`): it reads two stored or closed relations or more once its
 * imports are inlined, or it filters by a query a conjunction of which joins. A rule that reads one relation and
 * filters by no join is one lookup already; one navigation reads no part of is no join it reads. A filter by a query
 * that joins, read as written, is the query's join under the terms it is filtered at, which bind only the relations
 * whose columns the query's head delivers: qti's "Dependency target" negates DependencyResolved at a dependency's
 * (package, path, start), a join of Node and ResourceId at (package, path) under it, ResourceId bound by the
 * dependency's ref alone, which only the dependency's row holds. Navigated, each relation the query reads is a step
 * bound by the terms and the steps before it.
 */
const joins = (reads: RuleReads): boolean =>
	reads.one !== undefined && (reads.one > 1 || reads.filtersJoin)

/** Whether some conjunction of a rule joins (`joins`, `splits`), never built (`RuleReads` `most`). */
const someConjunctionJoins = (reads: RuleReads): boolean =>
	reads.most !== undefined && (reads.most > 1 || reads.filtersJoin)

/**
 * Whether navigation reads `source` apart as a chain that a restriction where it stands pays for (`navigatedRule`,
 * `Navigator.restrictedApart`): an import of one rule, its bind map binding no relation parameter (`scalarBinds`), that
 * reads one relation and joins only through a relational filter (`RuleReads` `one` 1 and `filtersJoin`). A union stays
 * one node, as a write member keeps every union (`sharedImports`): restricted per reader, its every rule was a copy of
 * its own, edullm's enterTest planning its entry's union in 44.3 MB where whole in 40.8. Its
 * chain apart is a fenced read of every row of that relation, each row refuted by the filter's chain of its own: edullm's
 * ledger finalize read every ended sitting's test_end row and refuted each by its pending attempts (82,526 at 1x for
 * the call's one sitting), and restricted the read is a lookup at the reader's values and the refutations run for its
 * rows alone, its planning 170.5 MB to 167.4. A rule that joins two relations or more already reads each step after its
 * first by the steps before, and restricted it paid the restriction's layers in every rule for no fewer rows: edullm's
 * enterTest planned its budget read in 40.8 MB, restricted in 46.6, finishTest's close in 131.4, restricted in 159.4.
 */
const chainedApart = (source: InferredSource, interned: Navigation): source is Imported => {
	if (
		source.kind !== "query" ||
		scalarBinds(source.bind) === undefined ||
		source.query.stage.kind !== "rules"
	) {
		return false
	}
	const [rule, ...more] = source.query.stage.arms
	const reads = interned.reads(rule)
	return more.length === 0 && reads.one === 1 && reads.filtersJoin
}

/**
 * `rule` navigated where it joins (`joins`); one that does not, with the query each of its steps and imports reads
 * navigated where it joins (`navigateQuery`), an import read apart as a chain of its own and bound at a variable a
 * match navigation reads where it stands binds restricted to its values (`Navigator.restrictedApart`);
 * itself where nothing in it joins. An aggregate's rule, which navigation
 * reads no part of (`RuleReads`), counts or folds the facts of the query it imports, read per unit inside a whole
 * rule's step: navigated, each relation that query joins is a lookup by every key column the steps before it bound,
 * where read as written PostgreSQL plans the join by its estimates of one unit's rows, a nested loop over a range of
 * the unit for each row of another, the unit's rows squared. A rule statement's rule over a chain of steps
 * (`overSteps`, `perStatement`) keeps its matches and has each relational filter navigated after them, as a chain's
 * filters are; a write member's (`perRead`) keeps its filters as written.
 */
const navigatedRule = (
	rule: InferredRule,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
	imports: KeptImports,
	interned: Navigation
): NonEmptyReadonlyArray<InferredRule> => {
	if (joins(interned.reads(rule))) {
		return navigate(rule, loc, columns, sharing, imports, interned)
	}
	const fixed = fixedTerms(rule)
	const navigator = new Navigator(loc, columns, sharing, interned)
	/**
	 * The variables the call's own rows bind, a relation input's match (`param`, `paramOf`): values the rule holds as it
	 * holds its parameters, at which every import the rule reads apart is restricted (`restrictedApart`), its chain
	 * starting where those rows bind it, once for each set of its columns they bind (Navigation `navigated`). No import
	 * binds them, so no two imports are correlated to each other. Navigated from no value, an import that joins, read
	 * beside the call's sittings at (child, stage), led with every learner's snapshots of one variable and read the
	 * sessions last (CARRYKEY's finding 5).
	 */
	const inputs = new Set(
		rule.matches.flatMap((m) =>
			m.source.kind === "param" || m.source.kind === "paramOf"
				? Object.values(m.bindings).flatMap((e) => [...readsOf(e)])
				: []
		)
	)
	/** The variables the matches bind that navigation reads where they stand, never apart as a chain. */
	const bound = new Set(
		rule.matches.flatMap((m) =>
			chainedApart(m.source, interned)
				? []
				: Object.values(m.bindings).flatMap((e) => [...readsOf(e)])
		)
	)
	const matches = rule.matches.map((m): InferredMatch => {
		const source = m.source
		if (source.kind === "step") {
			const query = navigatedQuery(source.query, loc, columns, sharing, interned)
			return query === source.query ? m : { ...m, source: { ...source, query } }
		}
		if (source.kind !== "query") {
			return m
		}
		const passes = passesThrough(source.query)
		const restricted = navigator.restrictedApart(
			m,
			source,
			chainedApart(source, interned) ? bound : passes ? inputs : noVariables,
			fixed
		)
		if (restricted !== undefined) {
			return restricted
		}
		const inside = boundInside(source, m.bindings, fixed, columns)
		const query = navigatedQuery(inside.query, loc, columns, sharing, interned)
		return query === source.query ? m : { ...m, source: { ...inside, query } }
	})
	const read = matches.every((m, i) => m === rule.matches[i]) ? rule : { ...rule, matches }
	return [
		sharing.kind === "perStatement" && (interned.overSteps(read) || read.where.some(testsGroups))
			? new Navigator(loc, columns, sharing, interned).filteredOverSteps(read, 0)
			: read
	]
}

/**
 * The term of `arm`'s head at `field` a filter binding it equates with its own term (Navigator #filtered): a term of the
 * arm's matches; none where the head folds or produces it, or holds no such field, which no step of the arm reads.
 */
const equatedAt = (arm: InferredRule, field: string): InferredExpr | undefined => {
	const head = arm.head[field]
	return head === undefined || head.kind === "aggregate" || head.kind === "producer"
		? undefined
		: head
}

/**
 * Whether `e` is a relational filter over a query's groups: one that tests only that a group stands at the terms it
 * binds, whose arm reads the body as a chain (`filteredArm`), or one whose arm matches an import of a rule that folds
 * (`foldsIn`) and reads its fold, which matches the groups as a step restricted inside at the group fields it binds
 * (Navigator #grouped, boundInside, as a rule's gained side reads them), the fold compared after. Either is navigated
 * after the rule's matches as they stand (Navigator.filteredOverSteps), as a rule over steps navigates its filters,
 * each step asking the index of its binding. As written it stayed the fold, its body one join PostgreSQL read by its
 * estimates beside each key, through no index of its binding (rule-aggregate's locality: a count by n of Attempt joined
 * to Topic under a containment into it at its fold, both tables hashed whole at the touched n, no index led by n). A
 * filter that binds a fold its own arm computes stays as written: the fold is over the arm's whole body, which no
 * binding of the filter restricts.
 */
const testsGroups = (e: InferredExpr): boolean =>
	isFiltered(e) &&
	e.source.kind === "query" &&
	e.source.query.stage.kind === "rules" &&
	e.source.query.stage.arms.some(
		(arm) =>
			filteredArm(arm, e.bindings) !== arm ||
			arm.matches.some((m) => foldsIn(m.source) !== undefined)
	)

/** An import a rule matches (ir/desc.ts SourceDesc `query`). */
type Imported = Extract<InferredSource, { readonly kind: "query" }>

/** No variable: an import read beside the call's rows that is restricted at none of theirs (`passesThrough`). */
const noVariables: ReadonlySet<string> = new Set()

/**
 * Whether `query` passes rows through: one rule, its head no fold's nor producer's, every match a stored or closed
 * relation, a delta or an import that passes rows through in turn, at any depth. Restricted at the call's rows
 * (navigatedRule `inputs`), such an import is correlated to them and read once for each of their rows, a lookup per row,
 * as many as the call holds. An import that computes apart, a fold, a union, a producer, stays navigated apart, and the
 * region's chain reads it at the key set of the call's rows (lower/shapes/region heldChain `keyset`), each distinct key
 * once, where correlated to the rows it was derived again for each row that repeats a key: two seats of one stage, the
 * stage's attempts read twice (held-drives `fold`).
 */
const passesThrough = (query: InferredQuery): boolean => {
	if (query.stage.kind !== "rules") {
		return false
	}
	const [rule, ...more] = query.stage.arms
	return (
		more.length === 0 &&
		Object.values(rule.head).every((h) => h.kind !== "aggregate" && h.kind !== "producer") &&
		rule.matches.every((m) =>
			m.source.kind === "relation" || m.source.kind === "delta"
				? true
				: (m.source.kind === "query" || m.source.kind === "step") && passesThrough(m.source.query)
		)
	)
}

/**
 * An import a rule matches at `bindings`, which navigation reads apart from the rule (`navigatedRule`), with each
 * binding the rule fixes (`fixedTerms`), to a parameter, a channel or a literal, equated inside each rule of the import
 * with the head term it binds, every parameter it reads passed in under a name of the import's own (`received`), at
 * every depth navigation reads
 * apart in turn: navigated apart, the
 * import's chain starts from those values. Outside it, beside steps PostgreSQL never pulls a condition into, the
 * equality left the chain's first step a read of every row: a whole rule's aggregate over the operands' join, its
 * groups bound to the unit's channels at its match, read every expression of every unit once per unit
 * (known_operand_base_key). A binding stays the match's alone where the import cannot hold it: at a field a rule's head
 * aggregates or produces, or reading a parameter the import already reads as another term. A bare literal, the head's
 * or the binding's, is typed at the import's column it stands for (leaves.ts atColumn).
 */
/** Whether `e` reads no variable of its rule: a parameter, a channel, a literal or a term of them alone. */
const isFixed = (e: InferredExpr): boolean => {
	const leaves = leavesOf(e)
	return leaves.vars.size === 0 && leaves.parents.size === 0
}

/**
 * The term each binding of a rule's matches fixes, where it reads no variable of the rule (`isFixed`) or is a variable
 * the rule's conditions equate with such a term, directly or through a chain of equalities between variables
 * (`equatedWith`): an aggregate's rule its import's group fields at the unit's channels a whole rule's step equates
 * them with (`boundInside`), and an import a rule binds at a variable its conditions equate with another that a
 * channel fixes, its head's equality stated by inlining another import (Navigator `#inline`).
 */
const fixedTerms = (rule: InferredRule): ((term: InferredExpr) => InferredExpr | undefined) => {
	const fixed = equatedWith(rule.where, isFixed)
	return (term) => (term.kind === "var" ? fixed(term.var) : isFixed(term) ? term : undefined)
}

/** The terms `flat`'s conditions fix its variables to (`fixedTerms`). */
const flatFixed = (
	flat: Flat,
	loc: SourceLoc
): ((term: InferredExpr) => InferredExpr | undefined) =>
	fixedTerms({
		vars: flat.vars,
		matches: [],
		where: flat.where,
		head: flat.head,
		interiors: [],
		attach: [],
		loc
	})

/**
 * A term of a rule as a filter of it is passed it (`Navigator.#filtered`): each variable the rule's conditions fix to a
 * parameter or a literal (`fixedTerms`) that term itself, a whole rule's unit channel or the literal, never a channel
 * of the filter's own bound to the variable. `fixedTerms` maps a variable only to a term `isFixed` admits, one that reads
 * no variable, so the filter is passed no variable of the rule in place of another.
 */
const pinnedBy =
	(fixed: (term: InferredExpr) => InferredExpr | undefined) =>
	(e: InferredExpr): InferredExpr =>
		mapLeaves(e, { var: (id) => fixed(varRef(id)), field: () => undefined })

/**
 * The parameter an import restricted inside (`boundInside`) receives its reader's parameter `name` under, a name its
 * own navigation never mints. That navigation is a Navigator of its own, which names its channels `via<depth>.<variable>`
 * from depth 0 and its inlined variables `n<k>.` from 0, as its reader's did, so the reader's channel `via0.n0.x` is a
 * name the import's steps mint again for a variable `n0.x` of their own. A step's bind map holds one entry per name: under
 * the reader's name, the step's channel took the entry, a condition the restriction placed in that step read the step's
 * variable for the reader's value, and the import's bind map named a parameter no rule of it read, which the checker
 * refuses (check/checker.ts #importAt), as it did a containment into a union of rules each inlining one import.
 */
const received = (name: string): string => (minted(name) ? `in.${name}` : name)

/**
 * Whether navigation minted the parameter `name`: a filter's channel (`Passing`, `via<depth>.`) or a parameter an
 * import received under a name of its own (`received`, `in.`); a declared parameter whose name starts so is renamed as
 * one, as every parameter was. Any other is the statement's own, a whole rule's unit
 * channel (analysis/theory/unit.ts `unit<j>`) or a query's declared parameter, which no navigation mints, so an import
 * receives it under its own name at every depth: an import restricted to the unit is one query wherever the statement
 * reads it, at the top or inside an import or a filter, where renamed at each depth it was a query of each depth. An
 * import that reads a parameter of that name itself keeps its own: `boundInside` holds no binding it would pass under
 * a name the import reads (`own`), so a reader's parameter never captures an import's.
 */
const minted = (name: string): boolean => name.startsWith("in.") || name.startsWith("via")

/**
 * Whether `e` concatenates texts, at any depth: a term an import is never restricted inside to (`boundInside`). A
 * concatenation of texts no pattern bounds stands in a query only where it is compared (scalar/compute/typing.ts
 * concat), and inside the import the equality of its head with it may define the head's variable, which navigation then
 * reads as the concatenation itself (`Navigator.#defined`), a head no query delivers: a matched union read at a key a
 * rule computes, pantry's prefixingReferences at `scope.variable`, was refused so. Its comparison stays the reader's,
 * outside the import.
 */
const concatenates = (e: InferredExpr): boolean =>
	(e.kind === "compute" && e.fn === "concat") || exprChildren(e).some((c) => concatenates(c.term))

const boundInside = (
	source: Imported,
	bindings: InferredBindings,
	fixed: (term: InferredExpr) => InferredExpr | undefined,
	columnsOf: QueryColumns
): Imported => {
	const stage = source.query.stage
	if (stage.kind !== "rules") {
		return source
	}
	const columns = columnsOf.desc(source.query)
	const own = queryParamNames(source.query)
	const bind: Record<string, Imported["bind"][string]> = { ...source.bind }
	/** Each binding held inside: its term, and the term each rule's head binds it at, rule by rule. */
	const held: Array<{ readonly term: InferredExpr; readonly heads: ReadonlyArray<InferredExpr> }> =
		[]
	for (const [field, bound] of Object.entries(bindings)) {
		const found = fixed(bound)
		if (found === undefined || concatenates(found)) {
			continue
		}
		const term = atColumn(found, field, columns)
		const leaves = leavesOf(term)
		const passed = leaves.params.flatMap((p) =>
			p.kind === "param" ? [{ kind: "param", name: p.name, type: p.type } as const] : []
		)
		const heads = stage.arms.flatMap((arm) => {
			const head = arm.head[field]
			return head === undefined || head.kind === "aggregate" || head.kind === "producer"
				? []
				: [atColumn(head, field, columns)]
		})
		if (
			passed.length < leaves.params.length ||
			heads.length < stage.arms.length ||
			passed.some((p) => own.has(received(p.name)))
		) {
			continue
		}
		for (const p of passed) {
			bind[received(p.name)] = p
		}
		held.push({
			term: boundIn(term, new Map(passed.map((p) => [p.name, { ...p, name: received(p.name) }]))),
			heads
		})
	}
	if (!isNonEmpty(held)) {
		return source
	}
	const arms = mapNonEmpty(stage.arms, (arm, i) => ({
		...arm,
		where: [
			...arm.where,
			...held.flatMap(({ term, heads }) => {
				const head = heads[i]
				return head === undefined ? [] : [equal(head, term)]
			})
		]
	}))
	return { ...source, bind, query: { ...source.query, stage: { ...stage, arms } } }
}

/**
 * A query navigated wherever it joins: each rule of its one rules stage that joins (`joins`) as a chain of steps
 * (`navigate`), and in each that does not, every step's query so, at any depth; the query itself where nothing in it
 * joins. A write member's query (write/frontend/compile.ts) is a rule over the live definitions its matches import, each
 * a join of a few stored relations, the whole a join of every relation they read. Every query the judge reads
 * (physical/ddl/rules.ts judgedStatement) is navigated so too: a rule probe's, over its region, and a whole rule's
 * violation over its units, whose rule read per unit is a step (analysis/theory/unit.ts unitStep), navigated where it
 * joins within the unit or negates a join, as qti's "Dependency target" does, so no estimate PostgreSQL makes, with
 * statistics or none, reads a join the judge reads as a product it filters afterwards. A rule over an imported query of
 * several rules, where one of its conjunctions (`splits`) joins, is navigated with each such import read whole, one
 * node, each of its rules navigated inside it (`sharedImports`), under either sharing. It is navigated within its
 * compile's `navigation`,
 * which navigates each query of one identity once for every query of the compile, and orders each chain by the
 * containments of the schema's theory it holds (Navigation `within`).
 */
export const navigateQuery = (
	query: InferredQuery,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
	navigation: Navigation
): InferredQuery => navigatedQuery(query, loc, columns, sharing, navigation)

/**
 * The successor read match `m` of `rule` is once the rule's other matches are read (analysis/theory/successor.ts): its
 * key's other fields and its cut bound by them, by a parameter or by a constant. Such a rule's fold reads one row of m
 * for each binding of the others, which navigation reads by one descent as it chains the rule (`#chain`), so the rule is
 * navigated whole, its fold over the chain, never over its body apart, whose chain sees no fold.
 */
const successorBeside = (
	rule: InferredRule,
	m: InferredMatch,
	interned: Navigation
): Successor | undefined => {
	if (m.source.kind !== "relation") {
		return undefined
	}
	const others = rule.matches.filter((o) => o !== m).flatMap((o) => Object.values(o.bindings))
	const bound = new Set(others.flatMap((e) => [...readsOf(e)]))
	return successorOf(
		m.bindings,
		interned.keysOf(m.source),
		{ head: rule.head, conditions: rule.where, beside: others },
		(v) => bound.has(v)
	)
}

/** `rule` read as its matches and conditions alone: its folds dropped from its head, what a chain reads of it. */
const foldsRemoved = (rule: InferredRule): InferredRule => ({
	...rule,
	head: Object.fromEntries(Object.entries(rule.head).filter(([, h]) => h.kind !== "aggregate"))
})

/** Whether `rule` folds the facts of its body at one group field or more: some head term aggregates, and some does not. */
const foldsAtGroups = (rule: InferredRule): boolean => {
	const heads = Object.values(rule.head)
	return heads.some((h) => h.kind === "aggregate") && heads.some((h) => h.kind !== "aggregate")
}

/**
 * `m` as a filter's arm reads it where it matches a query each of whose rules folds at one group field or more
 * (`foldsAtGroups`), every fold of it bound to a variable `readNowhere` says nothing else of the arm reads, or bound to
 * none: a match of the query's bodies, their folds dropped (`foldsRemoved`), at its group fields alone, since such a
 * match holds a row exactly where a group of the query stands, and a group stands exactly where its body holds a row (a
 * group is the body's rows at its group fields, check/checker.ts Group). Any other match as it is.
 */
const bodyOfGroups = (
	m: InferredMatch,
	readNowhere: (variable: string) => boolean
): InferredMatch => {
	const source = m.source
	if (source.kind !== "query" || Object.keys(source.bind).length > 0) {
		return m
	}
	const stage = source.query.stage
	if (stage.kind !== "rules" || !stage.arms.every(foldsAtGroups)) {
		return m
	}
	const folded = (field: string): boolean =>
		stage.arms.some((arm) => arm.head[field]?.kind === "aggregate")
	const freed = Object.entries(m.bindings).every(
		([field, e]) => !folded(field) || (e.kind === "var" && readNowhere(e.var))
	)
	return freed
		? {
				...m,
				source: {
					...source,
					query: {
						...source.query,
						stage: { ...stage, arms: mapNonEmpty(stage.arms, foldsRemoved) }
					}
				},
				bindings: Object.fromEntries(Object.entries(m.bindings).filter(([field]) => !folded(field)))
			}
		: m
}

/** The variables `rule` reads but through its `skipped`-th match: its head's, its conditions' and its other matches'. */
const readOutside = (rule: InferredRule, skipped: number): ReadonlySet<string> => {
	const read = new Set<string>()
	for (const h of Object.values(rule.head)) {
		for (const t of headTerms(h)) {
			varsOf(t, read)
		}
	}
	for (const w of rule.where) {
		varsOf(w, read)
	}
	for (const [at, m] of rule.matches.entries()) {
		if (at !== skipped) {
			for (const e of Object.values(m.bindings)) {
				varsOf(e, read)
			}
		}
	}
	return read
}

/**
 * An arm of a filtered query as a relational filter binding the fields `bindings` reads it (Navigator `#readable`,
 * `#filtered`), the filter testing only that a fact of it stands at them. An aggregating rule of one group field or more
 * whose folds the filter binds none of is its body, its folds dropped (`foldsRemoved`), and a rule matching a query of
 * such rules whose folds it reads nowhere else matches their bodies at its group fields (`bodyOfGroups`): a group stands
 * at its fields exactly where its body holds a row there (a group is the body's rows at its group fields,
 * check/checker.ts Group), and no condition of an aggregating rule reads a fold, which only its head computes. So a
 * negation or an existence of a query's groups at their keys reads the body as a chain, each relation stepped at what
 * the steps before it bound, and the index of each step's binding is requested, where it stayed a join PostgreSQL
 * ordered by its estimates, its fold computed for nothing (rule-aggregate's locality: a count by n of Attempt joined to
 * Topic under a containment into it, its groups at n read as a hash join of both tables whole, no index led by n). Any
 * other arm as it is: one whose fold the filter or the rule reads, one of no group field, whose fold stands over an empty
 * body too, one that folds what it matches, whose multiplicities its fold reads, and one that nests or attaches.
 */
const filteredArm = (arm: InferredRule, bindings: InferredBindings): InferredRule => {
	if (foldsAtGroups(arm)) {
		return Object.keys(bindings).every((field) => arm.head[field]?.kind !== "aggregate")
			? foldsRemoved(arm)
			: arm
	}
	if (
		Object.values(arm.head).some((h) => h.kind === "aggregate") ||
		arm.interiors.length > 0 ||
		arm.attach.length > 0
	) {
		return arm
	}
	const matches = arm.matches.map((m, at) => {
		const outside = readOutside(arm, at)
		return bodyOfGroups(m, (variable) => !outside.has(variable))
	})
	if (matches.every((m, at) => m === arm.matches[at])) {
		return arm
	}
	const bound = new Set<string>()
	for (const m of matches) {
		for (const e of Object.values(m.bindings)) {
			varsOf(e, bound)
		}
	}
	const read = readOutside({ ...arm, matches }, -1)
	return {
		...arm,
		vars: arm.vars.filter((v) => bound.has(v.id) || read.has(v.id)),
		matches
	}
}

/**
 * `navigateQuery` within one statement's navigation, its imports read whole interned in `interned`, each query of one
 * identity navigated once (Navigation `navigated`).
 */
const navigatedQuery = (
	query: InferredQuery,
	loc: SourceLoc,
	columns: QueryColumns,
	sharing: ImportSharing,
	interned: Navigation
): InferredQuery => {
	return interned.navigated(query, sharing, () => {
		const stage = query.stage
		if (stage.kind !== "rules") {
			return query
		}
		const extreme = extremeOf(stage, interned)
		if (extreme !== undefined) {
			return extreme
		}
		const keptOf = (rule: InferredRule): KeptImports => sharedImports([rule], interned, sharing)
		const arms = flatMapNonEmpty(stage.arms, (arm): NonEmptyReadonlyArray<InferredRule> => {
			if (!splits(arm) || !someConjunctionJoins(interned.reads(arm))) {
				return navigatedRule(arm, loc, columns, sharing, keptOf(arm), interned)
			}
			return navigate(arm, loc, columns, sharing, keptOf(arm), interned)
		})
		const navigated =
			arms.length === stage.arms.length && arms.every((rule, i) => rule === stage.arms[i])
				? stage
				: { ...stage, arms }
		const witnessed = oneWitness(navigated)
		return witnessed === undefined
			? navigated === stage
				? query
				: { ...query, stage: navigated }
			: { ...query, stage: witnessed }
	})
}

/** The first row of `stage`'s rows in the order of its column `column`, `dir`: take(1) of order([column]). */
const firstOf = (
	stage: InferredQuery["stage"],
	column: string,
	dir: Direction,
	loc: SourceLoc
): InferredQuery["stage"] => ({
	kind: "take",
	input: { kind: "order", input: stage, order: [{ column, dir }], loc },
	take: { kind: "literal", k: 1 },
	loc
})

/**
 * A rules stage of one rule that matches one relation M and folds a successor of it (analysis/theory/successor.ts), the
 * key's other fields and the cut fixed by the parameters and literals the rule reads, as the stage M's first row in
 * the fold's order past the cut, its head delivering that row's x where it folded x: one descent of M's key, where the
 * fold read every row of M at those values (ledger's latestMoments, a sitting's latest moment, its upkeep reading every
 * moment of the sitting at each write). Undefined for any other stage.
 */
const extremeOf = (
	stage: Extract<InferredQuery["stage"], { readonly kind: "rules" }>,
	interned: Navigation
): InferredQuery | undefined => {
	const [rule, ...more] = stage.arms
	const [match, ...others] = rule.matches
	const successor =
		more.length === 0 && match !== undefined && others.length === 0
			? successorBeside(rule, match, interned)
			: undefined
	const folded = Object.entries(rule.head).find(([, h]) => h.kind === "aggregate")
	if (successor === undefined || folded === undefined) {
		return undefined
	}
	const [column] = folded
	const read: InferredRule = {
		...rule,
		head: { ...rule.head, [column]: varRef(successor.variable) }
	}
	return {
		stage: firstOf(
			{ kind: "rules", arms: [read], loc: stage.loc },
			column,
			successor.dir,
			stage.loc
		)
	}
}

/**
 * A rules stage of one rule that reads a relation and whose every head term is a parameter or a literal, fixed before
 * its reads (a unit's channels, analysis/theory/unit.ts channelled), as the stage's first row: it derives one fact at
 * most, so one witness of its reads derives it, where its rows were read every one and their projection made distinct
 * (a sitting with an unsuspended visit, read at the sitting a write touched: every visit of the sitting). Undefined for
 * any other stage, one that folds or produces among them.
 */
const oneWitness = (
	stage: Extract<InferredQuery["stage"], { readonly kind: "rules" }>
): InferredQuery["stage"] | undefined => {
	const [rule, ...more] = stage.arms
	const [column] = Object.keys(rule.head)
	const pinned = Object.values(rule.head).every(
		(h) => h.kind !== "aggregate" && h.kind !== "producer" && readsOf(h).size === 0
	)
	return more.length > 0 || column === undefined || rule.matches.length === 0 || !pinned
		? undefined
		: firstOf(stage, column, "asc", stage.loc)
}
