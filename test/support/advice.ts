/**
 * The plan laws' one harness (docs/operations.md "Plan advice"): every statement grizzle emits carries the plan its compiler
 * proved to PostgreSQL 19 as plan advice (contrib/pg_plan_advice, sql/advice.ts printAdvice), and these are the laws
 * that hold it, each read off PostgreSQL itself.
 *
 * - **Law 1, plan identity.** Planned under its scope's advice, in force as production puts it in force (`Vehicle`), a
 *   statement's generated advice is the advice grizzle carries for it, atom for atom; every atom it carries is reported
 *   `matched`, with no flag; and no node is disabled. The comparison is CARRY-CONTRACT §3's: a generated atom whose
 *   targets grizzle named (an alias the scope minted, at the top level or a level it minted) is one of the carried, and
 *   every other is a NO_GATHER of a relation at a level PostgreSQL named (a sublink's one item, `"*RESULT*"`). The laws
 *   cover every statement over grizzle's own relations: a read of PostgreSQL's system catalogs stays cost-chosen, with
 *   real statistics and no proof of grizzle's, its plan item's scan `catalog` (sql/plan.ts PlanScan), which the
 *   advice holds no atom of and the budget bounds no scan of, as does a consumer's hand-written migration DML, which
 *   grizzle never binds, and the migration runner's own bookkeeping of its ledger (`__ledger`'s INSERT ... VALUES, its
 *   redraft's UPDATE and its head's one-row upsert), bounded by the ledger's size, the count of migrations; a drafted
 *   data step is bound and advised against the indexes in force when its file runs.
 * - **Law 2, binding.** Every column a read binds that its index stores (IndexRef `stores`) is in the index condition
 *   of its occurrence's scan, never in that scan's filter, and no column it binds is in a condition a join pairs its
 *   sides by: advice pins an index and a join, never which clauses become index conditions, so the statement's shape (a
 *   probe) must carry the binding. A bound column the index does not store is a residual filter on what the stored ones
 *   reach, a key bound in full leaving one row, the rows it reads the budget's to hold (INDEXES' rule). A bitmap read (a GIN
 *   search beside its scalar prefix, advised BITMAP_HEAP_SCAN) is a Bitmap Heap Scan over exactly one Bitmap Index Scan,
 *   whose index condition holds every column it binds and its matched one.
 * - **Law 3, scope.** Every target of a scope is one item's (an alias, `@` the level it stands in: a role's whole view
 *   stands under its body's one alias at every level that reads it), every level it names is named once, and every
 *   atom of the scope's advice is matched in exactly one of its statements: PostgreSQL applies one advice string to
 *   every statement it plans under it, so an alias two statements share meets the other's items.
 * - **The budget.** On filled data a statement reads within the pages its plan gives: each scan of an index its
 *   descents times the index's height, and two pages a row its index condition selects (its leaf entry and its heap
 *   tuple), an index-only scan one and its heap fetches; a bitmap read's index scan its descents times its GIN's
 *   height and a posting page a tuple id it returns, its heap scan the heap blocks it read, none of them lossy (a lossy
 *   block is a bitmap past work_mem, a failure); each whole read its table's pages; and no scan descends more than once
 *   an evaluation. Counted, never timed.
 *
 * Every plan is PostgreSQL's own: EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON) of
 * the statement, planned fresh under the advice in force, generic as every session grizzle opens plans
 * (physical/ddl/roles.ts genericPlans), which prints the advice that reproduces its plan, its feedback on each supplied
 * atom, and (pg_overexplain, which every test session preloads and which hooks EXPLAIN alone) each scan's range table
 * entry, its target. The replan
 * case alone reads a cached plan, which PostgreSQL records advice for only under
 * pg_plan_advice.always_store_advice_details: the harness sets it on its own observing session there, an observation
 * setting that changes no plan (pgpa_planner.c builds no trove unless advice is supplied). No planner setting is set.
 *
 * The tables a law reads stand in a pg_class state (`PgClassState`), each as production leaves one: never vacuumed;
 * counted empty, pg_class holding its pages and no row, as a VACUUM another session runs while its load is open counts
 * it (e1's tie, stated as that VACUUM states it); analyzed; skewed, analyzed over its first rows, then filled; and large,
 * pg_class counting a million rows on its pages, the scale of edullm's 1x tables. A case's rows are written once
 * (storedOnce) and each state it reads them in is stood over them by its statistics alone (statsStood, inState), so a
 * measured table holds each of its rows once, never a version a rolled-back load left that its snapshot does not see.
 */

import { assert, defined } from "@bjornpagen/testing/assert"
import { regex } from "arkregex"
import { Array as Arr, Data, Effect, Option, Record as Rec, Result, String as Str } from "effect"
import { fromEngine } from "#adapter/engine.ts"
import type { PageRuntime } from "#adapter/page/template.ts"
import { compiledPageTemplateFor } from "#adapter/served/forms.ts"
import {
	explain,
	explainServerStatement,
	type MalformedPlan,
	type PlanNode,
	planNodes,
	underGenericPlans
} from "#bench/harness/explain.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { quoteIdent, quoteString } from "#compiler/core/text.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import type { AdvisedFile, BoundDraft } from "#compiler/deploy/render/advise.ts"
import type { AccessIndexRequest, StatementSpec } from "#compiler/ir/products.ts"
import type { IndexRef, IndexResolver } from "#compiler/physical/indexes/ref.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import { compileParsed, parsedChange, servableEntry } from "#compiler/plan/change.ts"
import {
	type InstalledSource,
	type Isolation,
	noClock,
	type SchemaArtifacts,
	transactionClock
} from "#compiler/plan/common.ts"
import {
	type CompiledTemplate,
	type QueryTemplate,
	queryInput,
	readAdvice
} from "#compiler/plan/read.ts"
import type { AnyContext, AnySchema } from "#compiler/public/schema.ts"
import { printAdvice } from "#compiler/sql/advice.ts"
import { type EmittedSql, type ObjectName, transitionTables } from "#compiler/sql/ast.ts"
import {
	joinPlans,
	type PlanLevel,
	type ReadPlan,
	resolvePlan,
	scannedItems
} from "#compiler/sql/plan.ts"
import { printPlannedQuery, printStatement, textArrayLiteral } from "#compiler/sql/print.ts"
import type { AnyLoginRole } from "#compiler/types/schema/world.ts"
import { paramTexts } from "#test/support/compile.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { renamed } from "#test/support/installed.ts"
import type { SqlError } from "#test/support/pg.ts"
import { type RoleSetupError, servedRoleContext } from "#test/support/served-role.ts"
import { fullWorld } from "#test/support/worlds.ts"

/** Advice or a plan PostgreSQL printed that the harness cannot read: a defect of the reader or of the text. */
export class MalformedAdvice extends Data.TaggedError("MalformedAdvice")<{
	readonly message: string
}> {}

/** The tags whose targets are a relation and an index each (pgpa_parser.y index_target_list). */
const indexTags = ["INDEX_SCAN", "INDEX_ONLY_SCAN"] as const

/** The tags whose targets are relations (pgpa_parser.y simple_target_list). */
const scanTags = ["SEQ_SCAN", "TID_SCAN", "BITMAP_HEAP_SCAN", "NO_GATHER", "DO_NOT_SCAN"] as const

/** The tags whose targets are relations or lists of them (pgpa_parser.y generic_target_list). */
const joinTags = [
	"FOREIGN_JOIN",
	"GATHER",
	"GATHER_MERGE",
	"HASH_JOIN",
	"MERGE_JOIN_MATERIALIZE",
	"MERGE_JOIN_PLAIN",
	"NESTED_LOOP_MATERIALIZE",
	"NESTED_LOOP_MEMOIZE",
	"NESTED_LOOP_PLAIN",
	"PARTITIONWISE",
	"SEMIJOIN_NON_UNIQUE",
	"SEMIJOIN_UNIQUE"
] as const

type IndexTag = (typeof indexTags)[number]
type ScanTag = (typeof scanTags)[number]
type JoinTag = (typeof joinTags)[number]

const isIndexTag = (tag: string): tag is IndexTag => Arr.some(indexTags, (t) => t === tag)
const isScanTag = (tag: string): tag is ScanTag => Arr.some(scanTags, (t) => t === tag)
const isJoinTag = (tag: string): tag is JoinTag => Arr.some(joinTags, (t) => t === tag)

/** A schema-qualified name or a bare one: an index as advice names it, a partition. */
interface QualifiedName {
	readonly schema: Option.Option<string>
	readonly name: string
}

/**
 * A relation identifier (pgpa_identifier.c): its alias, its occurrence among the relations of its plan sharing the
 * alias (1 where the text states none), the partition it names, and the plan it is planned in (none: the top one).
 */
export interface RelationTarget {
	readonly alias: string
	readonly occurrence: number
	readonly partition: Option.Option<QualifiedName>
	readonly plan: Option.Option<string>
}

/** A join's target: one relation, an ordered list of targets, or an unordered set of relations (JOIN_ORDER's `{}`). */
type JoinTarget =
	| { readonly kind: "relation"; readonly relation: RelationTarget }
	| { readonly kind: "ordered"; readonly members: ReadonlyArray<JoinTarget> }
	| { readonly kind: "unordered"; readonly members: ReadonlyArray<RelationTarget> }

/**
 * One atom of advice: what PostgreSQL's feedback reports on one at a time (pgpa_trove.c, an entry a target), its tag,
 * its canonical text and the relations it names. An item of several targets is several atoms; a join order is one.
 */
export interface Atom {
	readonly tag: string
	readonly text: string
	readonly relations: ReadonlyArray<RelationTarget>
}

type Token =
	| { readonly kind: "ident"; readonly text: string }
	| { readonly kind: "integer"; readonly value: number }
	| { readonly kind: "punct"; readonly char: string }

/** The readers below throw MalformedAdvice, which `reading` returns as their failure. */
const malformed = (what: string): never => {
	throw new MalformedAdvice({ message: what })
}

/** Runs a reader, its MalformedAdvice the failure; any other throw is a defect. */
const reading = <A>(read: () => A): Result.Result<A, MalformedAdvice> => {
	try {
		return Result.succeed(read())
	} catch (error) {
		if (error instanceof MalformedAdvice) {
			return Result.fail(error)
		}
		throw error
	}
}

/**
 * Every lexeme of `text` by `pattern`, a sticky pattern each of whose matches is one lexeme, in order: a text it cannot
 * read on from some place is malformed.
 */
const lexemes = (pattern: RegExp, text: string): ReadonlyArray<RegExpExecArray> => {
	const found: Array<RegExpExecArray> = []
	let at = 0
	while (at < text.length) {
		pattern.lastIndex = at
		const m = pattern.exec(text)
		if (m === null || m[0] === "") {
			return malformed(`an unreadable text at ${at} of ${quoteString(text)}`)
		}
		found.push(m)
		at += m[0].length
	}
	return found
}

/**
 * Advice text's lexemes as pgpa_scanner.l reads them: whitespace and comments, which mean nothing; a double-quoted
 * identifier (1), each `""` in it one `"`; a bare identifier (2), folded to lower case; a decimal integer (3); and a
 * punctuation mark (4).
 */
const adviceLexeme = () =>
	regex(
		'\\s+|/\\*[\\s\\S]*?\\*/|"((?:[^"]|"")*)"|([A-Za-z\\u0080-\\u00ff_][A-Za-z\\u0080-\\u00ff_0-9$]*)|([0-9][0-9_]*)|([(){}#/.@])',
		"uy"
	)

/** The tokens of advice text. */
const tokensOf = (text: string): ReadonlyArray<Token> =>
	Arr.flatMap(
		lexemes(adviceLexeme(), text),
		([, quoted, bare, integer, punct]): ReadonlyArray<Token> => {
			if (quoted !== undefined) {
				return [{ kind: "ident", text: Str.replaceAll('""', '"')(quoted) }]
			}
			if (bare !== undefined) {
				return [{ kind: "ident", text: Str.toLowerCase(bare) }]
			}
			if (integer !== undefined) {
				return [{ kind: "integer", value: Number(Str.replaceAll("_", "")(integer)) }]
			}
			return punct === undefined ? [] : [{ kind: "punct", char: punct }]
		}
	)

/** An identifier as quote_identifier prints one: bare where folding leaves it alone, else double-quoted. */
const identText = (name: string): string =>
	regex("^[a-z_][a-z0-9_$]*$", "u").test(name) ? name : `"${Str.replaceAll('"', '""')(name)}"`

const qualifiedText = (q: QualifiedName): string =>
	Option.match(q.schema, {
		onNone: () => identText(q.name),
		onSome: (schema) => `${identText(schema)}.${identText(q.name)}`
	})

/** A relation identifier's text (pgpa_identifier.c pgpa_identifier_string): occurrence 1 unprinted. */
const relationText = (r: RelationTarget): string =>
	`${identText(r.alias)}${r.occurrence === 1 ? "" : `#${r.occurrence}`}${Option.match(r.partition, {
		onNone: () => "",
		onSome: (p) => `/${qualifiedText(p)}`
	})}${Option.match(r.plan, { onNone: () => "", onSome: (p) => `@${identText(p)}` })}`

const joinTargetText = (t: JoinTarget): string => {
	switch (t.kind) {
		case "relation":
			return relationText(t.relation)
		case "ordered":
			return `(${Arr.join(Arr.map(t.members, joinTargetText), " ")})`
		case "unordered":
			return `{${Arr.join(Arr.map(t.members, relationText), " ")}}`
	}
}

const joinRelations = (t: JoinTarget): ReadonlyArray<RelationTarget> => {
	switch (t.kind) {
		case "relation":
			return [t.relation]
		case "ordered":
			return Arr.flatMap(t.members, joinRelations)
		case "unordered":
			return t.members
	}
}

/** A cursor over advice tokens: a recursive descent over pgpa_parser.y, each reader throwing MalformedAdvice. */
class AdviceReader {
	#at = 0
	readonly #tokens: ReadonlyArray<Token>
	readonly #text: string

	constructor(text: string) {
		this.#text = text
		this.#tokens = tokensOf(text)
	}

	get done(): boolean {
		return this.#at >= this.#tokens.length
	}

	#fail(what: string): never {
		return malformed(`${what} at token ${this.#at} of ${quoteString(this.#text)}`)
	}

	#peek(char: string): boolean {
		const t = this.#tokens[this.#at]
		return t?.kind === "punct" && t.char === char
	}

	#take(char: string): void {
		if (!this.#peek(char)) {
			this.#fail(`expected ${char}`)
		}
		this.#at += 1
	}

	#ident(): string {
		const t = this.#tokens[this.#at]
		if (t?.kind !== "ident") {
			return this.#fail("expected an identifier")
		}
		this.#at += 1
		return t.text
	}

	#occurrence(): number {
		const t = this.#tokens[this.#at]
		if (t?.kind !== "integer" || t.value <= 0) {
			return this.#fail("expected a positive occurrence")
		}
		this.#at += 1
		return t.value
	}

	/** relation_identifier: identifier opt_ri_occurrence opt_partition opt_plan_name. */
	#relation(): RelationTarget {
		const alias = this.#ident()
		let occurrence = 1
		if (this.#peek("#")) {
			this.#take("#")
			occurrence = this.#occurrence()
		}
		let partition: Option.Option<QualifiedName> = Option.none()
		if (this.#peek("/")) {
			this.#take("/")
			const schema = this.#ident()
			this.#take(".")
			partition = Option.some({ schema: Option.some(schema), name: this.#ident() })
		}
		let plan: Option.Option<string> = Option.none()
		if (this.#peek("@")) {
			this.#take("@")
			plan = Option.some(this.#ident())
		}
		return { alias, occurrence, partition, plan }
	}

	/** index_name: identifier, or identifier '.' identifier. */
	#index(): QualifiedName {
		const first = this.#ident()
		if (!this.#peek(".")) {
			return { schema: Option.none(), name: first }
		}
		this.#take(".")
		return { schema: Option.some(first), name: this.#ident() }
	}

	/** join_order_target_list, up to (not past) `close`. */
	#orderTargets(close: string): ReadonlyArray<JoinTarget> {
		const targets: Array<JoinTarget> = []
		while (!this.#peek(close)) {
			if (this.#peek("(")) {
				this.#take("(")
				targets.push({ kind: "ordered", members: this.#orderTargets(")") })
				this.#take(")")
			} else if (this.#peek("{")) {
				this.#take("{")
				const members: Array<RelationTarget> = []
				while (!this.#peek("}")) {
					members.push(this.#relation())
				}
				this.#take("}")
				targets.push({ kind: "unordered", members })
			} else {
				targets.push({ kind: "relation", relation: this.#relation() })
			}
		}
		return targets
	}

	/** A join tag's one target: a relation, or a parenthesized list of them (pgpa_parser.y generic_sublist). */
	#joinTarget(): JoinTarget {
		if (!this.#peek("(")) {
			return { kind: "relation", relation: this.#relation() }
		}
		this.#take("(")
		const members: Array<JoinTarget> = []
		while (!this.#peek(")")) {
			members.push({ kind: "relation", relation: this.#relation() })
		}
		this.#take(")")
		return { kind: "ordered", members }
	}

	/** One advice item, as its atoms. */
	item(): ReadonlyArray<Atom> {
		const tag = Str.toUpperCase(this.#ident())
		this.#take("(")
		const atoms: Array<Atom> = []
		if (tag === "JOIN_ORDER") {
			const targets = this.#orderTargets(")")
			atoms.push({
				tag,
				text: `JOIN_ORDER(${Arr.join(Arr.map(targets, joinTargetText), " ")})`,
				relations: Arr.flatMap(targets, joinRelations)
			})
		} else if (isIndexTag(tag)) {
			while (!this.#peek(")")) {
				const relation = this.#relation()
				const index = this.#index()
				atoms.push({
					tag,
					text: `${tag}(${relationText(relation)} ${qualifiedText(index)})`,
					relations: [relation]
				})
			}
		} else if (isScanTag(tag)) {
			while (!this.#peek(")")) {
				const relation = this.#relation()
				atoms.push({ tag, text: `${tag}(${relationText(relation)})`, relations: [relation] })
			}
		} else if (isJoinTag(tag)) {
			while (!this.#peek(")")) {
				const target = this.#joinTarget()
				atoms.push({
					tag,
					text: `${tag}(${joinTargetText(target)})`,
					relations: joinRelations(target)
				})
			}
		} else {
			this.#fail(`an unknown tag ${tag}`)
		}
		this.#take(")")
		return atoms
	}
}

/** The atoms of advice text, in its order: what grizzle carries, or what PostgreSQL generated. */
const atomsOf = (text: string): Result.Result<ReadonlyArray<Atom>, MalformedAdvice> =>
	reading(() => {
		const reader = new AdviceReader(text)
		const atoms: Array<Atom> = []
		while (!reader.done) {
			for (const atom of reader.item()) {
				atoms.push(atom)
			}
		}
		return atoms
	})

/** A flag of PostgreSQL's feedback on a supplied atom (pgpa_trove.c pgpa_trove_append_flags). */
type FeedbackFlag = "inapplicable" | "conflicting" | "failed"

const isFlag = (word: string): word is FeedbackFlag =>
	word === "inapplicable" || word === "conflicting" || word === "failed"

/** How PostgreSQL applied one supplied atom: its match, and each flag it raised. Law 1 admits `matched` with none. */
export interface Feedback {
	readonly match: "matched" | "partially matched" | "not matched"
	readonly flags: ReadonlyArray<FeedbackFlag>
}

/** A supplied atom and PostgreSQL's feedback on it: one line of "Supplied Plan Advice", `<atom> /* <feedback> *\/`. */
export interface Supplied {
	readonly atom: Atom
	readonly feedback: Feedback
}

/** Each match PostgreSQL's feedback names, by its text. */
const matches: ReadonlyMap<string, Feedback["match"]> = new Map([
	["matched", "matched"],
	["partially matched", "partially matched"],
	["not matched", "not matched"]
])

const feedbackLine = () =>
	regex(
		"^(.*) /\\* (matched|partially matched|not matched)((?:, (?:inapplicable|conflicting|failed))*) \\*/$",
		"u"
	)

/** Each line of "Supplied Plan Advice": its one atom and its feedback. */
const suppliedOf = (text: string): ReadonlyArray<Supplied> =>
	Arr.map(
		Arr.filter(Str.split("\n")(text), (line) => Str.trim(line) !== ""),
		(line): Supplied => {
			const [, item, matchText, flags] = feedbackLine().exec(line) ?? []
			const match = matches.get(matchText ?? "")
			if (item === undefined || match === undefined || flags === undefined) {
				return malformed(`a feedback line ${quoteString(line)}`)
			}
			const [atom, ...more] = Result.getOrElse(atomsOf(item), (e) => malformed(e.message))
			if (atom === undefined || more.length > 0) {
				return malformed(`a feedback line of one atom ${quoteString(line)}`)
			}
			return {
				atom,
				feedback: { match, flags: Arr.filter(Str.split(", ")(flags), isFlag) }
			}
		}
	)

/** A column a condition names, as VERBOSE prints it: its relation's alias and its name. */
export interface ColumnRef {
	readonly alias: string
	readonly column: string
}

/**
 * A condition's lexemes as VERBOSE prints it: a string literal; a cast's `::`; an operator of two characters, `<>`,
 * `<=`, `>=` or `!=`; a double-quoted identifier (1); a bare identifier (2); a dot (3); an opening parenthesis (4); the
 * equality `=` (5); and any other character, whitespace among them.
 */
const conditionLexeme = () =>
	regex(
		`'(?:[^']|'')*'|::|<>|<=|>=|!=|"((?:[^"]|"")*)"|([A-Za-z\\u0080-\\u00ff_][A-Za-z\\u0080-\\u00ff_0-9$]*)|(\\.)|(\\()|(=)|[\\s\\S]`,
		"uy"
	)

/**
 * A condition's lexeme as `columnsIn` and `equalitiesIn` read it: an identifier, a dot, a cast, a call's parenthesis,
 * the equality, or another.
 */
type ConditionToken =
	| { readonly kind: "ident"; readonly name: string }
	| { readonly kind: "dot" | "cast" | "open" | "eq" | "other" }

const conditionTokens = (condition: string): ReadonlyArray<ConditionToken> =>
	Arr.flatMap(lexemes(conditionLexeme(), condition), (m): ReadonlyArray<ConditionToken> => {
		const [whole, quoted, bare, dot, open, eq] = m
		if (quoted !== undefined) {
			return [{ kind: "ident", name: Str.replaceAll('""', '"')(quoted) }]
		}
		if (bare !== undefined) {
			return [{ kind: "ident", name: bare }]
		}
		if (dot !== undefined) {
			return [{ kind: "dot" }]
		}
		if (open !== undefined) {
			return [{ kind: "open" }]
		}
		if (eq !== undefined) {
			return [{ kind: "eq" }]
		}
		if (whole === "::") {
			return [{ kind: "cast" }]
		}
		return Str.trim(whole) === "" ? [] : [{ kind: "other" }]
	})

/**
 * Every column a condition PostgreSQL printed under VERBOSE names, each `alias.column`, either part double-quoted where
 * quote_identifier quotes it: two identifiers a dot joins, outside every string literal, that no `::` types and no `(`
 * calls.
 */
const columnsIn = (condition: string): ReadonlyArray<ColumnRef> => {
	const tokens = conditionTokens(condition)
	return Arr.flatMap(tokens, (_, at) => Option.toArray(columnAt(tokens, at)))
}

/** The column `alias.column` the tokens start at `at`, none where they start none (see `columnsIn`). */
const columnAt = (tokens: ReadonlyArray<ConditionToken>, at: number): Option.Option<ColumnRef> => {
	const qualifier = tokens[at]
	const dot = tokens[at + 1]
	const column = tokens[at + 2]
	const before = tokens[at - 1]
	const after = tokens[at + 3]
	return qualifier?.kind === "ident" &&
		dot?.kind === "dot" &&
		column?.kind === "ident" &&
		before?.kind !== "cast" &&
		before?.kind !== "dot" &&
		after?.kind !== "open" &&
		after?.kind !== "dot"
		? Option.some({ alias: qualifier.name, column: column.name })
		: Option.none()
}

/** Each equality a condition states between two columns, `a.x = b.y`, its two columns. */
const equalitiesIn = (condition: string): ReadonlyArray<readonly [ColumnRef, ColumnRef]> => {
	const tokens = conditionTokens(condition)
	return Arr.flatMap(tokens, (t, at) =>
		t.kind === "eq"
			? Option.toArray(Option.all([columnAt(tokens, at - 3), columnAt(tokens, at + 1)] as const))
			: []
	)
}

/**
 * One node of a plan as the laws read it: its type, the alias EXPLAIN displays for the relation occurrence it scans and
 * the occurrence's target (none where it scans none: see `targetsOf`), the index it reads, whether the planner disabled it (`Disabled: true`, a path advice forbade that nothing
 * could replace), and its conditions' columns: its index condition's (a TID scan's TID condition among them), its
 * filter's, and a join's, the Join Filter, Hash Cond and Merge Cond it pairs its sides by, with each equality its Join
 * Filter states between two columns; and whether it scans a stored relation. A Bitmap Heap Scan's Recheck Cond repeats
 * its Bitmap Index Scan's index condition, and is no filter.
 */
export interface LawNode {
	readonly nodeType: string
	readonly alias: Option.Option<string>
	readonly target: Option.Option<string>
	readonly index: Option.Option<string>
	readonly disabled: boolean
	readonly indexCond: ReadonlyArray<ColumnRef>
	readonly filter: ReadonlyArray<ColumnRef>
	readonly joined: ReadonlyArray<ColumnRef>
	readonly equated: ReadonlyArray<readonly [ColumnRef, ColumnRef]>
	readonly stored: boolean
	/** The stored relation it scans, `schema.name` where VERBOSE prints its schema, its name alone where not. */
	readonly relation: Option.Option<string>
	readonly children: ReadonlyArray<LawNode>
}

/** A statement's plan under the advice in force: its nodes, PostgreSQL's advice for it, and its feedback on the supplied. */
export interface AdvisedPlan {
	readonly root: LawNode
	readonly generated: ReadonlyArray<Atom>
	readonly supplied: Option.Option<ReadonlyArray<Supplied>>
}

type Json = Readonly<Record<string, unknown>>

const isJson = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

const textAt = (o: Json, key: string): Option.Option<string> => {
	const value = o[key]
	if (value === undefined) {
		return Option.none()
	}
	return typeof value === "string" ? Option.some(value) : malformed(`${key} is not text`)
}

const columnsAt = (o: Json, keys: ReadonlyArray<string>): ReadonlyArray<ColumnRef> =>
	Arr.flatMap(keys, (k) => Option.match(textAt(o, k), { onNone: () => [], onSome: columnsIn }))

/** A node's children: none where EXPLAIN printed no Plans. */
const childrenOf = (targets: ReadonlyMap<number, string>, o: Json): ReadonlyArray<LawNode> => {
	const plans = o["Plans"]
	if (plans === undefined) {
		return []
	}
	return Arr.isArray(plans)
		? Arr.map(plans, (p: unknown) =>
				isJson(p) ? lawNodeOf(targets, p) : malformed("a child plan")
			)
		: malformed("Plans is not a list")
}

const lawNodeOf = (targets: ReadonlyMap<number, string>, o: Json): LawNode => ({
	nodeType: Option.getOrElse(textAt(o, "Node Type"), () => malformed("a node with no Node Type")),
	alias: textAt(o, "Alias"),
	target: Option.map(
		integerAt(o, "Scan RTI"),
		(rti) =>
			targets.get(rti) ??
			malformed(`a scan of range table entry ${rti}, which the range table lacks`)
	),
	index: textAt(o, "Index Name"),
	disabled: o["Disabled"] === true,
	indexCond: columnsAt(o, ["Index Cond", "TID Cond"]),
	filter: columnsAt(o, ["Filter"]),
	joined: columnsAt(o, ["Join Filter", "Hash Cond", "Merge Cond"]),
	equated: Option.match(textAt(o, "Join Filter"), { onNone: () => [], onSome: equalitiesIn }),
	stored: o["Relation Name"] !== undefined,
	relation: Option.map(textAt(o, "Relation Name"), (name) =>
		Option.match(textAt(o, "Schema"), {
			onNone: () => name,
			onSome: (schema) => `${schema}.${name}`
		})
	),
	children: childrenOf(targets, o)
})

const integerAt = (o: Json, key: string): Option.Option<number> => {
	const value = o[key]
	if (value === undefined) {
		return Option.none()
	}
	return typeof value === "number" && Number.isInteger(value)
		? Option.some(value)
		: malformed(`${key} is not an integer`)
}

/** The name an identifier quote_identifier printed spells: its quotes and each doubled quote in it undone. */
const unquoted = (printed: string): string =>
	Str.startsWith('"')(printed) ? Str.replaceAll('""', '"')(Str.slice(1, -1)(printed)) : printed

/**
 * An alias as pg_overexplain prints one (pg_overexplain.c overexplain_alias): its name, quoted where quote_identifier
 * quotes it, then its column names in parentheses; the name alone.
 */
const aliasName = (printed: string): string => {
	const [, name] = regex('^("(?:[^"]|"")*"|[^ (]+) \\(', "u").exec(printed) ?? []
	return name === undefined ? malformed(`an alias ${quoteString(printed)}`) : unquoted(name)
}

/**
 * Each range table entry's target, by its index, as pg_overexplain's EXPLAIN (RANGE_TABLE) prints the range table
 * (pg_overexplain.c overexplain_range_table): the entry's alias (its reference name, `Eref`, where it was given none),
 * `@` the subplan it was planned in where it was planned in one, the name pg_plan_advice targets the occurrence by
 * (pgpa_identifier.c). A scan node's `Scan RTI` is its entry, so each scan is its target exactly, where EXPLAIN's
 * display names are made unique past it: a role's whole view stands under its body's one alias at every level that
 * reads it, `v1@r4` and `v1@r6`, displayed v1_1 and v1_2.
 */
const targetsOf = (top: Json): ReadonlyMap<number, string> => {
	const entries = top["Range Table"]
	if (!Arr.isArray(entries)) {
		return malformed("a plan printed with no range table (EXPLAIN (RANGE_TABLE), pg_overexplain)")
	}
	return new Map(
		Arr.map(entries, (entry: unknown) => {
			if (!isJson(entry)) {
				return malformed("a range table entry")
			}
			const rti = Option.getOrElse(integerAt(entry, "RTI"), () => malformed("an entry with no RTI"))
			const alias = aliasName(
				Option.getOrElse(
					Option.orElse(textAt(entry, "Alias"), () => textAt(entry, "Eref")),
					() => malformed(`entry ${rti} with no alias`)
				)
			)
			return [
				rti,
				Option.match(textAt(entry, "Subplan"), {
					onNone: () => alias,
					onSome: (plan) => `${alias}@${plan}`
				})
			] as const
		})
	)
}

/** The one object of an EXPLAIN (FORMAT JSON) cell, the json value as the driver returns it, parsed or as text. */
const topOf = (cell: unknown): Json => {
	const parsed: unknown = typeof cell === "string" ? trustedJson<unknown>(cell) : cell
	const [top, ...more] = Arr.isArray(parsed) ? parsed : []
	return isJson(top) && more.length === 0 ? top : malformed("an EXPLAIN cell that is not one plan")
}

/** A plan as EXPLAIN (PLAN_ADVICE, VERBOSE, FORMAT JSON) printed it, read for the laws. */
export const advisedPlanOf = (cell: unknown): Result.Result<AdvisedPlan, MalformedAdvice> =>
	reading(() => {
		const top = topOf(cell)
		const plan = top["Plan"]
		return {
			root: isJson(plan)
				? lawNodeOf(targetsOf(top), plan)
				: malformed("an EXPLAIN cell with no Plan"),
			generated: Result.getOrElse(
				atomsOf(Option.getOrElse(textAt(top, "Generated Plan Advice"), () => "")),
				(e) => malformed(e.message)
			),
			supplied: Option.map(textAt(top, "Supplied Plan Advice"), suppliedOf)
		}
	})

/**
 * Every node of a plan, its root first.
 *
 * @yields each node, the root, then each child's nodes in turn
 */
export function* lawNodes(n: LawNode): Generator<LawNode> {
	yield n
	for (const c of n.children) {
		yield* lawNodes(c)
	}
}

/**
 * How a scope's advice is in force when PostgreSQL plans its statements, as production carries it: a client flight's,
 * the advice its served record ships (ServedRead, ServedPage and ServedWrite `advice`), set for its transaction
 * (`set_config('pg_plan_advice.advice', $n, true)`, as the flight's prologue sets it); an installed routine's, its own
 * SET clause, which the harness reads back from the catalog (pg_proc.proconfig) and puts in force the same way, so a
 * routine that lost its clause plans under none. Law 1 holds what the vehicle holds to what the scope's plans carry:
 * a record that ships less than its transaction may send, or a clause that lost an item, fails it.
 */
export type Vehicle =
	| { readonly kind: "flight"; readonly advice: string }
	| { readonly kind: "routine"; readonly routine: ObjectName; readonly fires: RoutineFiring }

/**
 * Where a routine's queries are planned, as PostgreSQL plans them: a function's at its call (`called`), whose every name
 * is the installation's or a stand-up's; a rule capture's (sql/ast.ts CreateTransitionTrigger) inside the statement
 * trigger that fires it on `table`, whose queries read the trigger's transition tables (sql/ast.ts transitionTables),
 * which exist only there.
 */
export type RoutineFiring =
	| { readonly kind: "called" }
	| { readonly kind: "capture"; readonly table: ObjectName }

/**
 * A read the binding law judges: the alias of its relation's occurrence, its target (the alias, `@` the level the scope
 * named where the read stands in one), and the columns its index condition binds.
 */
export interface BoundRead {
	readonly alias: string
	readonly target: string
	readonly bound: ReadonlyArray<string>
	/** The columns its index stores as themselves (physical/indexes/ref.ts IndexRef `stores`), the tuple id for a tid read. */
	readonly stores: ReadonlyArray<string>
}

/** One statement of a scope: its label, and its text, every parameter a typed placeholder (`$n::type`). */
export interface ScopeStatement {
	readonly label: string
	readonly sql: string
}

/**
 * Which of its transaction's statements a scope's `statements` are: `every` statement it may send, so each atom of its
 * advice is matched in exactly one of them; or the statements one call `sent`, a write's, whose parted statements send
 * the units its call's facts need and whose read-backs and refused COMMIT's witness are sent where it needs them, so each
 * atom is matched in at most one of them, an atom of what the call did not send in none (Law 3).
 */
export const scopeSends = ["every", "sent"] as const

export type ScopeSends = (typeof scopeSends)[number]

/**
 * An advice scope as the laws read it (CARRY-CONTRACT §4, sql/naming.ts AdviceScope): its label; the advice grizzle
 * carries for it; its plan's names, each item's alias and its target once for each item it scans (a whole view's alias,
 * the view body's, stands at each level that reads it, its targets apart by their levels) and each level it named once
 * for each level; its reads, each by its target with the columns its index condition binds, a TID scan's its ctid; the
 * aliases of its reads of PostgreSQL's system catalogs (PlanScan `catalog`), which Law 1 and the budget leave to
 * PostgreSQL's costs; its statements; and its vehicle.
 */
export interface LawScope {
	readonly label: string
	readonly sends: ScopeSends
	readonly advice: string
	readonly aliases: ReadonlyArray<string>
	readonly targets: ReadonlyArray<string>
	readonly levels: ReadonlyArray<string>
	readonly reads: ReadonlyArray<BoundRead>
	readonly catalog: ReadonlyArray<string>
	readonly statements: Arr.NonEmptyReadonlyArray<ScopeStatement>
	readonly vehicle: Vehicle
}

/** An item's target at `level` (pgpa_identifier.c): its alias, `@` the level's name where the scope named the level. */
const targetAt = (level: PlanLevel<IndexRef>, alias: string): string =>
	level.name.kind === "named" ? `${alias}@${level.name.name}` : alias

/**
 * The names and reads of a plan of one scope (sql/plan.ts ReadPlan), as a LawScope holds them: each scanned item's
 * alias and target (its join problem's and its append relations' members, sql/plan.ts scannedItems), each named level's
 * name, and each read's binding, an index or bitmap read's bound columns and a TID read's ctid.
 */
export const planFacts = (
	plan: ReadPlan<IndexRef>
): Pick<LawScope, "aliases" | "targets" | "levels" | "reads" | "catalog"> => ({
	aliases: Arr.flatMap(plan.levels, (level) => Arr.map(scannedItems(level), (item) => item.alias)),
	targets: Arr.flatMap(plan.levels, (level) =>
		Arr.map(scannedItems(level), (item) => targetAt(level, item.alias))
	),
	levels: Arr.flatMap(plan.levels, (level) =>
		level.name.kind === "named" ? [level.name.name] : []
	),
	reads: Arr.flatMap(plan.levels, (level) =>
		Arr.flatMap(scannedItems(level), (item): ReadonlyArray<BoundRead> => {
			const target = targetAt(level, item.alias)
			switch (item.scan.kind) {
				case "index":
				case "bitmap":
					return [
						{ alias: item.alias, target, bound: item.scan.bound, stores: item.scan.index.stores }
					]
				case "tid":
					return [{ alias: item.alias, target, bound: ["ctid"], stores: ["ctid"] }]
				case "seq":
				case "rows":
				case "catalog":
					return []
			}
		})
	),
	catalog: Arr.flatMap(plan.levels, (level) =>
		Arr.flatMap(scannedItems(level), (item) => (item.scan.kind === "catalog" ? [item.alias] : []))
	)
})

/**
 * Every installed routine's scope (physical/install/compile.ts Installation `routines`): its function, its plan and its
 * advice printed from it, which its own SET clause carries (sql/print.ts createFunctionBlock), and each query PL/pgSQL
 * hands the planner, its PL/pgSQL names typed placeholders (sql/print.ts printPlannedQuery). A routine that plans no
 * query has no scope.
 */
export const routineScopes = (installation: Installation): ReadonlyArray<LawScope> =>
	Arr.flatMap(installation.routines, (routine) => {
		const [first, ...rest] = Arr.map(routine.planned, (sql, at): ScopeStatement => ({
			label: `query ${at + 1}`,
			sql
		}))
		return first === undefined
			? []
			: [
					{
						label: `the routine ${routine.fn.schema}.${routine.fn.name}`,
						sends: "every",
						advice: printAdvice(routine.plan),
						...planFacts(routine.plan),
						statements: [first, ...rest],
						vehicle: {
							kind: "routine",
							routine: routine.fn,
							fires: firingOf(installation, routine.fn)
						}
					}
				]
	})

/**
 * How `fn`'s queries are planned (RoutineFiring): inside the statement trigger that fires it where a transition trigger
 * of the installation executes it, on the one table every such trigger of it is on; at its call otherwise.
 */
const firingOf = (installation: Installation, fn: ObjectName): RoutineFiring => {
	const tables = Arr.dedupeWith(
		Arr.flatMap(installation.statements, (s): ReadonlyArray<ObjectName> =>
			s.kind === "createTransitionTrigger" &&
			s.function.schema === fn.schema &&
			s.function.name === fn.name
				? [s.table]
				: []
		),
		(a: ObjectName, b: ObjectName) => a.schema === b.schema && a.name === b.name
	)
	const [table, ...more] = tables
	if (more.length > 0) {
		return malformed(`a capture ${fn.schema}.${fn.name} fired on ${tables.length} tables`)
	}
	return table === undefined ? { kind: "called" } : { kind: "capture", table }
}

/**
 * A client flight's scope: the statements `sent` one transaction may send, each its text and the plan it was bound with
 * under the transaction's one scope (sql/emit.ts EmittedSql), their plans' reads resolved by the installation that
 * serves them (`resolve`), its advice what those plans carry (sql/advice.ts printAdvice), and its vehicle the advice its
 * served record ships (`shipped`), which the flight's prologue sets.
 */
export const flightScope = (
	label: string,
	sent: Arr.NonEmptyReadonlyArray<Pick<EmittedSql, "text" | "plan">>,
	resolve: IndexResolver,
	shipped: string
): LawScope => {
	const plan = resolvePlan(joinPlans(Arr.map(sent, (s) => s.plan)), resolve)
	return {
		label,
		sends: "every",
		advice: printAdvice(plan),
		...planFacts(plan),
		statements: Arr.map(sent, (s, at): ScopeStatement => ({
			label: `statement ${at + 1}`,
			sql: s.text
		})),
		vehicle: { kind: "flight", advice: shipped }
	}
}

/**
 * What PostgreSQL plans of a migration file's draft as the file writes it (deploy/render/advise.ts BoundDraft), with the
 * plan it was bound with: a data step's statement, and a law's violation check's probe of its violation query as
 * PL/pgSQL hands the planner the block's PERFORM (physical/ddl/recheck.ts violationCheck, sql/print.ts printPlannedQuery
 * `found`); none of any other draft, which reads no stored row grizzle binds.
 */
export const draftPlanned = (
	draft: BoundDraft
): Option.Option<{ readonly sql: string; readonly plan: ReadPlan<AccessIndexRequest> }> => {
	switch (draft.kind) {
		case "step":
			return Option.some({ sql: printStatement(draft.statement), plan: draft.plan })
		case "violation": {
			const [found, ...more] = draft.block.body
			return found.kind === "whenFound" && more.length === 0
				? Option.some({
						sql: printPlannedQuery({ kind: "found", query: found.query }),
						plan: draft.plan
					})
				: assert.fail(`the violation check of ${draft.law} probes its violation query alone`)
		}
		case "statement":
		case "alteration":
		case "fill":
		case "zones":
		case "loss":
		case "confirm":
			return Option.none()
	}
}

/**
 * The scope of a migration file's data steps (docs/operations.md "Plan advice"): each as PostgreSQL plans it (`draftPlanned`), with
 * its bound plan (AdvisedFile `drafts`), each plan's reads resolved by the installation (`resolve`); its advice what those
 * plans carry, and its vehicle the advice the runner sets (`set`), its transaction's first statement. A file of no data
 * step carries no advice, and has no scope.
 */
export const fileScope = (file: AdvisedFile, resolve: IndexResolver, set: string): LawScope => {
	const steps = Arr.flatMap(file.drafts, (d) => Option.toArray(draftPlanned(d)))
	const [first, ...rest] = Arr.map(steps, (s, at): ScopeStatement => ({
		label: `data step ${at + 1}`,
		sql: s.sql
	}))
	if (first === undefined) {
		return assert.fail(`${file.file.name} runs a data step`)
	}
	const plan = resolvePlan(joinPlans(Arr.map(steps, (s) => s.plan)), resolve)
	return {
		label: `the data steps of ${file.file.name}`,
		sends: "every",
		advice: printAdvice(plan),
		...planFacts(plan),
		statements: [first, ...rest],
		vehicle: { kind: "flight", advice: set }
	}
}

/**
 * A read as a served Db of `role` runs it: compiled at the call as the role compiles every read no one compiled ahead
 * (test/support/served-role.ts servedRoleContext, adapter/served/role.ts RoleContext `compile`), as generate compiles a
 * workload's rows member (engine program/workload/reads.ts compiledRead: the snapshot context, rows, the transaction's
 * clock), over the installation `installed` the role reads: its template, its one statement, the texts of a call's
 * parameters by their names (test/support/compile.ts paramTexts), and the flight scope of its statement
 * (`flightScope`), each read resolved as the role resolves it (RoleContext `resolve`), the installation's own
 * resolutions, its vehicle the advice its served record ships (engine program/served.ts readAdvice).
 */
export interface ServedRead {
	readonly template: QueryTemplate
	readonly statement: StatementSpec
	readonly params: (values: Readonly<Record<string, unknown>>) => ReadonlyArray<string>
	readonly scope: LawScope
}

/** `query` read as a served Db of `role` over `installed` runs it (ServedRead), its flight labelled `label`. */
export const servedRead = (
	installed: Installed,
	role: AnyLoginRole,
	query: unknown,
	label: string
): Effect.Effect<ServedRead, CompileError | RoleSetupError> =>
	Effect.gen(function* () {
		const context = yield* servedRoleContext(installed, role)
		const input = yield* fromEngine(queryInput(query))
		const { compiled } = yield* fromEngine(
			context.compile(input, {
				context: "snapshot",
				read: "rows",
				clock: noClock,
				source: transactionClock
			})
		)
		const template = compiled.template
		const [statement, ...others] = template.optimized
		assert.ok(statement !== undefined && others.length === 0, `${label} is one statement`)
		const declared = { params: template.params, codes: context.artifacts.names.codes }
		return {
			template,
			statement,
			params: (values) => paramTexts(statement, values, declared),
			scope: flightScope(
				label,
				[{ text: statement.sql, plan: statement.plan }],
				context.resolve,
				readAdvice(template, context.resolve)
			)
		}
	})

/**
 * The plan of the write a served Db of `role` makes of the ChangeSet `changes` at `level`, the isolation its role is
 * certified at, as the one compile `grizzle generate` commits makes it (adapter/served/forms.ts writeEntry: the
 * ChangeSet parsed over the role's schema and compiled over its artifacts, engine program/workload/change.ts
 * compileParsed), every statement its flight may send bound under its transaction's one scope (ServableWrite `plan`),
 * each read resolved as the role resolves it.
 */
export const servedWritePlan = (
	installed: Installed,
	role: AnyLoginRole,
	changes: unknown,
	level: Isolation
): Effect.Effect<ReadPlan<IndexRef>, CompileError | RoleSetupError> =>
	Effect.gen(function* () {
		const context = yield* servedRoleContext(installed, role)
		const change = yield* fromEngine(parsedChange(context.schema, changes))
		const entry = yield* fromEngine(
			compileParsed(context.artifacts, change, new Set(), level, noClock, context.clock)
		)
		return resolvePlan(servableEntry(entry).compiled.plan, context.resolve)
	})

/**
 * The scope of one call a served Db made (`label`): its transaction's plan `plan`, resolved; the statements it sent past
 * its prologue, each by the text its session parsed, which are every statement it may send (`every`, a read's one) or
 * those its call needed (`sent`, a write's: ScopeSends); and the advice its served record ships, which its prologue set.
 */
export const callScope = (
	label: string,
	sends: ScopeSends,
	plan: ReadPlan<IndexRef>,
	statements: Arr.NonEmptyReadonlyArray<ScopeStatement>,
	shipped: string
): LawScope => ({
	label,
	sends,
	advice: printAdvice(plan),
	...planFacts(plan),
	statements,
	vehicle: { kind: "flight", advice: shipped }
})

/**
 * A page as a served Db of `role` runs it (engine program/workload/reads.ts compiledRead's page): its ordered query compiled
 * at the call for a page (RoleContext `compile`, read "page"), its page compiled over the role's artifacts and served
 * with every window's statement under the advice its served record ships (forms.ts compiledPageTemplateFor, engine
 * program/served.ts pageAdvice); and the flight scope of its five window variants' statements (`flightScope`), one
 * transaction's, each read resolved as the role resolves it. The compiled template and the artifacts are what a second
 * implementation of the page is built from (test/support/conservative.ts conservativePageRuntime).
 */
export interface ServedPageRead {
	readonly runtime: PageRuntime
	readonly compiled: CompiledTemplate
	readonly artifacts: SchemaArtifacts<InstalledSource>
	readonly scope: LawScope
}

/** `query`, an ordered query, paged as a served Db of `role` over `installed` pages it (ServedPageRead). */
export const servedPageRead = (
	installed: Installed,
	role: AnyLoginRole,
	query: unknown,
	label: string
): Effect.Effect<ServedPageRead, CompileError | RoleSetupError> =>
	Effect.gen(function* () {
		const context = yield* servedRoleContext(installed, role)
		const input = yield* fromEngine(queryInput(query))
		const { compiled, artifacts } = yield* fromEngine(
			context.compile(input, {
				context: "snapshot",
				read: "page",
				clock: noClock,
				source: transactionClock
			})
		)
		const page = yield* Effect.fromResult(
			compiledPageTemplateFor({
				template: compiled.template,
				desc: compiled.desc,
				artifacts,
				resolve: context.resolve
			})
		)
		const { requests } = page.template.artifact
		return {
			runtime: page.runtime,
			compiled,
			artifacts,
			scope: flightScope(
				label,
				[
					requests.first.program.statement.sql,
					requests.after.program.statement.sql,
					requests.last.program.statement.sql,
					requests.before.program.statement.sql,
					requests.at.program.statement.sql
				],
				context.resolve,
				page.runtime.page.advice
			)
		}
	})

/**
 * The statement `read` sends run at `params`, each parameter a caller's value by its name, under the read's flight
 * advice once the plan laws hold over it (`advisedRun`), in the transaction `session` holds open: the plan a budget
 * over it reads.
 */
export const servedRun = (
	session: BenchSession,
	read: ServedRead,
	params: Readonly<Record<string, unknown>>
): Effect.Effect<PlanNode, SqlError | MalformedAdvice | MalformedPlan> =>
	advisedRun(session, read.scope, read.scope.statements[0].sql, read.params(params))

/**
 * The role of `fixture`'s full world over `installed` (test/support/worlds.ts fullWorld), declaring `contexts`, those
 * the template that installed it declared: `fixture` rebuilt under the installation's declared name, as a full-world
 * template installs it (test/support/installed.ts fullVersion), and its login's one role, which every program of the
 * world's workload is served through.
 */
export const fullWorldRole = (
	installed: Installed,
	fixture: AnySchema,
	contexts: ReadonlyArray<AnyContext>
): AnyLoginRole => fullWorld(renamed(fixture, installed.declared), {}, contexts).server.roles.app

/** A scope planned: the advice its vehicle held in force, and each statement's plan under it, in the scope's order. */
export interface PlannedScope {
	readonly inForce: string
	readonly plans: ReadonlyArray<AdvisedPlan>
}

/** The atoms of `text`, a text the scope's own construction made: one that is no advice is a defect. */
const carriedAtoms = (text: string): ReadonlyArray<Atom> =>
	Result.getOrElse(atomsOf(text), (e) => {
		throw e
	})

/** A plan's feedback on the supplied atoms: none where it was planned under no advice. */
const suppliedIn = (plan: AdvisedPlan): ReadonlyArray<Supplied> =>
	Option.getOrElse(plan.supplied, Arr.empty<Supplied>)

/** Whether grizzle named every relation an atom targets: an alias `minted`, at the top level or a level it minted. */
const namedBy = (minted: ReadonlySet<string>, atom: Atom): boolean =>
	Arr.every(
		atom.relations,
		(r) =>
			minted.has(r.alias) &&
			Option.match(r.plan, { onNone: () => true, onSome: (p) => minted.has(p) })
	)

/** A node as a failure names it: its type, its occurrence's alias and its index. */
const nodeText = (n: LawNode): string =>
	`${n.nodeType}${Option.match(n.alias, { onNone: () => "", onSome: (a) => ` of ${a}` })}${Option.match(
		n.index,
		{
			onNone: () => "",
			onSome: (i) => ` using ${i}`
		}
	)}`

/**
 * Law 1 over each statement of `scope`, `planned` under the advice its vehicle held (see the header): the vehicle held
 * the scope's advice; a statement's own atoms (those of the scope's advice it reports `matched`) are its generated
 * atoms grizzle named, each matched with no flag; every other generated atom is a NO_GATHER; and no node is disabled.
 */
const planIdentity = (scope: LawScope, planned: PlannedScope): ReadonlyArray<string> => {
	const minted = new Set([...scope.aliases, ...scope.levels])
	const catalog = new Set(scope.catalog)
	const carried = new Set(Arr.map(carriedAtoms(scope.advice), (a) => a.text))
	const held = new Set(Arr.map(carriedAtoms(planned.inForce), (a) => a.text))
	const vehicle = [
		...Arr.flatMap([...carried], (t) =>
			held.has(t) ? [] : [`${scope.label}: its vehicle holds no ${t}`]
		),
		...Arr.flatMap([...held], (t) =>
			carried.has(t) ? [] : [`${scope.label}: its vehicle holds ${t}, which it does not carry`]
		)
	]
	const statements = Arr.flatMap(
		Arr.zip<ScopeStatement, AdvisedPlan>(scope.statements, planned.plans),
		([s, plan]) => {
			const label = `${scope.label}, ${s.label}`
			const supplied = suppliedIn(plan)
			const own = new Set(
				Arr.flatMap(supplied, (x) => (x.feedback.match === "matched" ? [x.atom.text] : []))
			)
			const generated = Arr.filter(
				plan.generated,
				(a) => !Arr.some(a.relations, (r) => catalog.has(r.alias))
			)
			const ours = Arr.filter(generated, (a) => namedBy(minted, a))
			const oursText = new Set(Arr.map(ours, (a) => a.text))
			return [
				...(carried.size > 0 && Option.isNone(plan.supplied)
					? [`${label}: planned under no advice`]
					: []),
				...Arr.flatMap(supplied, (x) =>
					x.feedback.match === "not matched" ||
					(x.feedback.match === "matched" && x.feedback.flags.length === 0)
						? []
						: [
								`${label}: ${x.atom.text} ${Arr.join([x.feedback.match, ...x.feedback.flags], ", ")}`
							]
				),
				...Arr.flatMap([...oursText], (t) =>
					own.has(t) ? [] : [`${label}: PostgreSQL planned ${t}, which grizzle does not carry`]
				),
				...Arr.flatMap([...own], (t) =>
					oursText.has(t) ? [] : [`${label}: grizzle carries ${t}, which PostgreSQL did not plan`]
				),
				...Arr.flatMap(generated, (a) =>
					namedBy(minted, a) || a.tag === "NO_GATHER"
						? []
						: [`${label}: PostgreSQL planned ${a.text} at a level grizzle did not name`]
				),
				...Arr.flatMap([...lawNodes(plan.root)], (n) =>
					n.disabled ? [`${label}: its ${nodeText(n)} is disabled`] : []
				)
			]
		}
	)
	return [...vehicle, ...statements]
}

/**
 * Law 2 over `scope`, `planned`: every column each read binds that its index stores is in the index condition of the one
 * scan of its target among the scope's statements (a scan's target its range table entry's, `targetsOf`, its
 * conditions naming it by the alias EXPLAIN displays), never in that scan's filter, and none it binds is in a condition
 * a join of that statement pairs its sides by; and no join's filter equates a column of a stored read with another's, a
 * binding the statement's shape lost to a plain join, which the binder makes a probe (sql/bind.ts: a stored table an
 * earlier item binds is never a set join's inner).
 */
const binding = (scope: LawScope, planned: PlannedScope): ReadonlyArray<string> => {
	const statements = Arr.map(planned.plans, (p) => [...lawNodes(p.root)])
	const names = (refs: ReadonlyArray<ColumnRef>, alias: string, column: string): boolean =>
		Arr.some(refs, (r) => r.alias === alias && r.column === column)
	const lost = Arr.flatMap(statements, (nodes) => {
		const storedAliases = new Set(
			Arr.flatMap(nodes, (n) => (n.stored ? Option.toArray(n.alias) : []))
		)
		return Arr.flatMap(nodes, (n) =>
			Arr.flatMap(n.equated, ([a, b]) =>
				storedAliases.has(a.alias) || storedAliases.has(b.alias)
					? [
							`${scope.label}: its ${nodeText(n)} filters ${a.alias}.${a.column} = ${b.alias}.${b.column} after joining, a binding of a stored read no index condition holds`
						]
					: []
			)
		)
	})
	return [
		...lost,
		...Arr.flatMap(scope.reads, (read) => {
			const scans = Arr.flatMap(statements, (nodes) =>
				Arr.flatMap(nodes, (n) =>
					Option.contains(n.target, read.target) &&
					Str.endsWith(" Scan")(n.nodeType) &&
					n.nodeType !== "Subquery Scan"
						? [{ scan: n, nodes }]
						: []
				)
			)
			const [found, ...more] = scans
			if (found === undefined || more.length > 0) {
				return [`${scope.label}: the read ${read.target} is scanned ${scans.length} times`]
			}
			const { scan, nodes } = found
			const shown = Option.getOrElse(scan.alias, () => read.alias)
			const bitmaps = Arr.filter(scan.children, (c) => c.nodeType === "Bitmap Index Scan")
			const [bitmap, ...others] = bitmaps
			if (
				scan.nodeType === "Bitmap Heap Scan" &&
				(bitmap === undefined || others.length > 0 || scan.children.length !== 1)
			) {
				return [
					`${scope.label}: the read ${read.target} is a ${nodeText(scan)} over ${scan.children.length} nodes, where one Bitmap Index Scan serves it`
				]
			}
			const indexCond = bitmap === undefined ? scan.indexCond : bitmap.indexCond
			return Arr.flatMap(read.bound, (column) => {
				const stored = read.stores.includes(column)
				const where = [
					...(!stored || names(indexCond, shown, column) ? [] : ["outside its index condition"]),
					...(stored && names(scan.filter, shown, column) ? ["in its filter"] : []),
					...(Arr.some(nodes, (n) => names(n.joined, shown, column))
						? ["in a join's condition"]
						: [])
				]
				return where.length === 0
					? []
					: [
							`${scope.label}: ${read.target}.${column} is bound, read ${Arr.join(where, " and ")} of its ${nodeText(scan)}`
						]
			})
		})
	]
}

/** Each of `names` that `of` holds more than once, the problem it is in `label`'s scope. */
const repeated = (
	label: string,
	of: string,
	names: ReadonlyArray<string>
): ReadonlyArray<string> => {
	const counts = new Map<string, number>()
	for (const name of names) {
		counts.set(name, (counts.get(name) ?? 0) + 1)
	}
	return Arr.flatMap([...counts], ([name, n]) =>
		n > 1 ? [`${label}: ${n} ${of} are ${name}`] : []
	)
}

/**
 * Law 3 over `scope`, `planned`: no two items of its plan share a target and no two of its levels a name, and every atom
 * of its advice is matched in exactly one of its statements, or, of the statements one call sent, in at most one
 * (ScopeSends).
 */
const scopeLaw = (scope: LawScope, planned: PlannedScope): ReadonlyArray<string> => [
	...repeated(scope.label, "items", scope.targets),
	...repeated(scope.label, "levels", scope.levels),
	...Arr.flatMap(Arr.dedupe(Arr.map(carriedAtoms(scope.advice), (a) => a.text)), (t) => {
		const matchedIn = Arr.flatMap(
			Arr.zip<ScopeStatement, AdvisedPlan>(scope.statements, planned.plans),
			([s, p]) =>
				Arr.some(suppliedIn(p), (x) => x.atom.text === t && x.feedback.match === "matched")
					? [s.label]
					: []
		)
		return matchedIn.length === 1 || (scope.sends === "sent" && matchedIn.length === 0)
			? []
			: [
					`${scope.label}: ${t} is matched in ${matchedIn.length} of its statements${matchedIn.length > 0 ? ` (${Arr.join(matchedIn, ", ")})` : ""}`
				]
	})
]

/** Laws 1, 2 and 3 over a planned scope: every problem they find. */
export const lawsOver = (scope: LawScope, planned: PlannedScope): ReadonlyArray<string> => [
	...planIdentity(scope, planned),
	...binding(scope, planned),
	...scopeLaw(scope, planned)
]

/**
 * The function every law plans a statement through, made in the session's own pg_temp: EXPLAIN (GENERIC_PLAN, COSTS
 * OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON) of the statement's text, run as dynamic SQL, so its typed
 * placeholders are the generic plan's own parameters. Sent over the extended protocol, the one every test session
 * speaks, a text with `$n` in it asks the call for those values, and EXPLAIN (GENERIC_PLAN) plans at them. A
 * transaction a test opens its own way (a Db's frame) defines it with `lawPlanner` and plans each statement by
 * `lawPlanOf`, its text the one parameter.
 */
export const lawPlanner =
	"CREATE OR REPLACE FUNCTION pg_temp.gz_laws_plan(statement text) RETURNS json LANGUAGE plpgsql AS $$ " +
	"DECLARE plan json; BEGIN EXECUTE 'EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON) ' || statement INTO plan; RETURN plan; END $$"

/** The query that plans the statement its one parameter's text holds, through `lawPlanner`: one cell, the plan. */
export const lawPlanOf = "SELECT pg_temp.gz_laws_plan($1::text)::text"

/** The query that answers the advice in force where it runs: one cell, the empty text where none is. */
export const adviceInForce =
	"SELECT COALESCE(pg_catalog.current_setting('pg_plan_advice.advice', true), '')"

/** A statement's plan for the laws, through the session's planner function (`lawPlanner`). */
const lawPlan = (session: BenchSession, sql: string) =>
	Effect.flatMap(session.values(lawPlanOf, [sql]), (rows) =>
		Effect.fromResult(advisedPlanOf(rows[0]?.[0]))
	)

/** The advice in force for the rest of the transaction `session` holds open: `advice`, or none where it is empty. */
const holdAdvice = (session: BenchSession, advice: string) =>
	session.values("SELECT pg_catalog.set_config('pg_plan_advice.advice', $1::text, true)", [advice])

/**
 * The statement that puts the advice routine `fn`'s SET clause holds (pg_proc.proconfig) in force for the rest of the
 * transaction it runs in, and answers it, none where the routine holds no clause: a routine's vehicle read from the
 * catalog, as PostgreSQL applies it at each call, for whatever plans a routine's statements outside a call of it.
 */
export const routineAdviceHeld = (fn: ObjectName): string =>
	"SELECT pg_catalog.set_config('pg_plan_advice.advice', COALESCE((SELECT pg_catalog.substr(c, " +
	"pg_catalog.length('pg_plan_advice.advice=') + 1) FROM pg_catalog.pg_proc AS p JOIN pg_catalog.pg_namespace AS n " +
	"ON n.oid = p.pronamespace CROSS JOIN LATERAL pg_catalog.unnest(p.proconfig) AS c " +
	`WHERE n.nspname = ${quoteString(fn.schema)} AND p.proname = ${quoteString(fn.name)} ` +
	"AND pg_catalog.starts_with(c, 'pg_plan_advice.advice=')), ''), true)"

/**
 * The advice `scope`'s vehicle holds (`Vehicle`), put in force for the rest of the transaction `session` holds open: a
 * flight's, the advice its record ships; a routine's, its SET clause as the catalog stores it.
 */
const holdVehicle = (session: BenchSession, scope: LawScope): Effect.Effect<string, SqlError> =>
	Effect.gen(function* () {
		const vehicle = scope.vehicle
		if (vehicle.kind === "flight") {
			yield* holdAdvice(session, vehicle.advice)
			return vehicle.advice
		}
		const held = yield* session.values(routineAdviceHeld(vehicle.routine), [])
		return String(held[0]?.[0])
	})

/**
 * Every statement of `scope` planned under the advice its vehicle holds, in the transaction `session` holds open, which
 * the advice stays in force in until it ends or another scope is planned: the advice in force, and each plan. The
 * library must be loaded on the session: without it EXPLAIN has no PLAN_ADVICE option.
 */
export const plannedScope = (
	session: BenchSession,
	scope: LawScope
): Effect.Effect<PlannedScope, SqlError | MalformedAdvice> =>
	Effect.gen(function* () {
		const inForce = yield* holdVehicle(session, scope)
		const vehicle = scope.vehicle
		const plans =
			vehicle.kind === "routine" && vehicle.fires.kind === "capture"
				? yield* capturedPlans(session, vehicle.fires.table, scope.statements)
				: yield* Effect.andThen(
						session.values(lawPlanner, []),
						Effect.forEach(scope.statements, (s) => lawPlan(session, s.sql))
					)
		return { inForce, plans }
	})

/**
 * A capture's queries planned where PostgreSQL plans them, inside a statement trigger on `table` whose transition tables
 * its queries read (RoutineFiring `capture`), in the transaction `session` holds open, under the advice in force there:
 * a trigger of the harness's own on `table`, AFTER UPDATE with the capture's REFERENCING (`news` the rows after, `olds`
 * before), fired once by an UPDATE of no row (a statement trigger fires for a statement that writes none), each query's
 * EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON) EXECUTEd in its body, where
 * PL/pgSQL holds the transition tables for every query it runs, as the capture's own queries read them; then dropped.
 * The capture itself stays as installed and fires too, on rows of none: the harness plans its queries beside it, since
 * EXPLAIN inside its own body is no statement grizzle installs, and outside a trigger no transition table exists to read.
 */
const capturedPlans = (
	session: BenchSession,
	table: ObjectName,
	statements: ReadonlyArray<ScopeStatement>
): Effect.Effect<ReadonlyArray<AdvisedPlan>, SqlError | MalformedAdvice> =>
	Effect.gen(function* () {
		const quoted = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
		yield* session.values(
			"CREATE TEMPORARY TABLE IF NOT EXISTS gz_laws_captured (n int4 PRIMARY KEY, statement text NOT NULL, plan json)",
			[]
		)
		yield* session.values("DELETE FROM pg_temp.gz_laws_captured", [])
		yield* Effect.forEach(
			statements,
			(s, at) =>
				session.values(
					"INSERT INTO pg_temp.gz_laws_captured (n, statement) VALUES ($1::int4, $2::text)",
					[String(at), s.sql]
				),
			{ discard: true }
		)
		yield* session.values(
			"CREATE OR REPLACE FUNCTION pg_temp.gz_laws_capture() RETURNS trigger LANGUAGE plpgsql AS $$ " +
				"DECLARE r record; p json; BEGIN FOR r IN SELECT n, statement FROM pg_temp.gz_laws_captured ORDER BY n LOOP " +
				"EXECUTE 'EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON) ' || r.statement INTO p; " +
				"UPDATE pg_temp.gz_laws_captured SET plan = p WHERE n = r.n; END LOOP; RETURN NULL; END $$",
			[]
		)
		yield* session.values(
			`CREATE TRIGGER gz_laws_capture AFTER UPDATE ON ${quoted} REFERENCING NEW TABLE AS ${transitionTables.news} OLD TABLE AS ${transitionTables.olds} FOR EACH STATEMENT EXECUTE FUNCTION pg_temp.gz_laws_capture()`,
			[]
		)
		const [column] = yield* session.values(
			"SELECT pg_catalog.quote_ident(a.attname::text) FROM pg_catalog.pg_attribute AS a WHERE a.attrelid = $1::text::pg_catalog.regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum LIMIT 1",
			[quoted]
		)
		const updated = String(defined(column?.[0], `a column of ${quoted} to update`))
		yield* session.values(`UPDATE ${quoted} SET ${updated} = ${updated} WHERE false`, [])
		yield* session.values(`DROP TRIGGER gz_laws_capture ON ${quoted}`, [])
		const rows = yield* session.values(
			"SELECT plan::text FROM pg_temp.gz_laws_captured ORDER BY n",
			[]
		)
		return yield* Effect.forEach(rows, (row) => Effect.fromResult(advisedPlanOf(row[0])))
	})

/**
 * The laws over `scope` held in the transaction `session` holds open (`plannedScope`, `lawsOver`): a problem one finds
 * is the case's failure, with every problem the laws found.
 */
export const lawsHold = (
	session: BenchSession,
	scope: LawScope
): Effect.Effect<void, SqlError | MalformedAdvice> =>
	Effect.map(plannedScope(session, scope), (planned) =>
		assert.deepEqual(
			lawsOver(scope, planned),
			[],
			`the plan laws hold over ${scope.label}, carrying ${scope.advice}\n${Arr.join(
				Arr.map(scope.statements, (s) => `${s.label}: ${s.sql}`),
				"\n"
			)}`
		)
	)

/**
 * A statement of a flight's `scope`, its text `sql`, run as every session grizzle opens runs it, the plan a budget over
 * it reads: the laws held over its scope first (`lawsHold`), then, under the same advice, run (`advisedExplain`).
 * EXPLAIN ANALYZE runs the statement: a write writes.
 */
export const advisedRun = (
	session: BenchSession,
	scope: LawScope,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<PlanNode, SqlError | MalformedAdvice | MalformedPlan> =>
	Effect.andThen(lawsHold(session, scope), advisedExplain(session, sql, params))

/**
 * `sql` run under the advice in force in the transaction `session` holds open, as every session grizzle opens runs it:
 * PREPAREd and run by EXPLAIN (ANALYZE, BUFFERS, VERBOSE, TIMING OFF, SETTINGS, FORMAT JSON) EXECUTE at `params`, each
 * a parameter's text, generic as every session plans it (bench/harness/explain.ts explainServerStatement), one plan for
 * every value of them. EXPLAIN of the statement with its parameters bound would plan it at their values, a plan no
 * session of grizzle runs. EXPLAIN ANALYZE runs the statement: a write writes.
 */
export const advisedExplain = (
	session: BenchSession,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<PlanNode, SqlError | MalformedPlan> =>
	Effect.map(
		explainServerStatement(session, sql, params, "generic", {
			serialize: { kind: "off" },
			wal: false,
			verbose: true
		}),
		(explained) => explained.plan
	)

/**
 * A pg_class state of a table a law reads, each reached as production reaches it (`standIn`):
 * - `never vacuumed`: its rows inserted, and nothing since (relpages 0, reltuples -1: the planner reads its size off
 *   its file);
 * - `counted empty`: its rows inserted and counted as a VACUUM another session runs while the load is open counts them,
 *   as autovacuum meets a long load (relpages its pages, reltuples 0: every path costs about a row, the tie of e1);
 * - `analyzed`: ANALYZEd over its rows;
 * - `skewed`: ANALYZEd over its first hundredth, then filled, its statistics a prefix's;
 * - `large`: pg_class counting `largeRows` rows on its pages, as at scale.
 */
export const pgClassStates = [
	"never vacuumed",
	"counted empty",
	"analyzed",
	"skewed",
	"large"
] as const

export type PgClassState = (typeof pgClassStates)[number]

/**
 * The rows a table in the `large` state is counted at: a million, past every cost tie a population of a few pages and
 * one of millions straddle, as the plan contracts sized their tables (test/pg/contracts/observed.ts).
 *
 * @limitKind measured
 * @owner the plan laws (test/support/advice.ts)
 * @unit rows a table holds, as pg_class records them
 * @scope every table a law stands in the large state
 * @evidence a table as installed plans at ten pages of rows (PostgreSQL 19 tableam.c
 *   table_block_relation_estimate_size), some two thousand narrow rows; a million is five hundred times past it, the
 *   scale of edullm's 1x tables (PERFBAR), where a scan's price passes a probe's for every table of more than a few pages
 */
const largeRows = 1_000_000

/**
 * A load a law stands in a state: the tables it fills, each quoted and qualified, and how it fills them, in `units`
 * units (rows, documents, packages: whatever the load counts), units `from` to `to` of 1 to `units` at a call, both
 * included, each call in the transaction its session holds open, or committed, as a seed through the judge commits its
 * rows, its error `E` and its requirement `R` the load's own.
 */
export interface StateLoad<E = SqlError, R = never> {
	readonly tables: Arr.NonEmptyReadonlyArray<string>
	readonly units: number
	readonly load: (from: number, to: number) => Effect.Effect<void, E, R>
}

/** Each of `tables`, by the statement `of` makes of it, run on `session`. */
const eachTable = (
	session: BenchSession,
	tables: ReadonlyArray<string>,
	of: (quoted: string) => string
): Effect.Effect<void, SqlError> =>
	Effect.forEach(tables, (t) => session.values(of(t), []), { discard: true })

/**
 * The statement that counts a table at `rows` rows on the pages it holds now (pg_restore_relation_stats), none of them
 * all-visible: as a VACUUM counts it, its pages read off its blocks.
 */
const countedAt = (quoted: string, rows: number): string =>
	"SELECT pg_catalog.pg_restore_relation_stats('schemaname', n.nspname::pg_catalog.text, 'relname', c.relname::pg_catalog.text, " +
	"'relpages', (pg_catalog.pg_relation_size(c.oid) / pg_catalog.current_setting('block_size')::pg_catalog.int8)::pg_catalog.int4, " +
	`'reltuples', ${rows}::pg_catalog.float4, 'relallvisible', 0::pg_catalog.int4) ` +
	"FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
	`WHERE c.oid = ${quoteString(quoted)}::pg_catalog.regclass`

/**
 * The relations a state of the tables `$1` names (a text array of quoted, qualified names) is counted on: each table and
 * each index of one, by its oid, the first column: an ANALYZE writes the counts of both in place (PostgreSQL 19
 * analyze.c do_analyze_rel, vac_update_relstats).
 */
const measuredRelations =
	"SELECT (t::pg_catalog.regclass)::pg_catalog.oid AS oid FROM pg_catalog.unnest($1::pg_catalog.text[]) AS t " +
	"UNION ALL SELECT i.indexrelid FROM pg_catalog.pg_index AS i " +
	"WHERE i.indrelid = ANY (SELECT t::pg_catalog.regclass FROM pg_catalog.unnest($1::pg_catalog.text[]) AS t)"

/**
 * A relation's pg_class counts, each its text, as an ANALYZE writes them in place and no rollback puts them back
 * (`apart`): the relation, a measured table or an index of one, by its oid.
 */
interface ClassCounts {
	readonly relation: string
	readonly relpages: string
	readonly reltuples: string
	readonly relallvisible: string
	readonly relallfrozen: string
}

/** The pg_class counts of `tables` and their indexes (measuredRelations), as `session` reads them (ClassCounts). */
const classCounts = (
	session: BenchSession,
	tables: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<ClassCounts>, SqlError> =>
	Effect.map(
		session.values(
			"SELECT c.oid::pg_catalog.text, c.relpages::pg_catalog.text, c.reltuples::pg_catalog.text, c.relallvisible::pg_catalog.text, c.relallfrozen::pg_catalog.text " +
				`FROM (${measuredRelations}) AS m JOIN pg_catalog.pg_class AS c ON c.oid = m.oid ORDER BY c.oid`,
			[textArrayLiteral(tables)]
		),
		Arr.map(([relation, relpages, reltuples, relallvisible, relallfrozen]) => ({
			relation: String(relation),
			relpages: String(relpages),
			reltuples: String(reltuples),
			relallvisible: String(relallvisible),
			relallfrozen: String(relallfrozen)
		}))
	)

/**
 * Each relation of `saved` stood at its saved counts again by `session` (pg_restore_relation_stats, a transactional
 * update of its pg_class row).
 */
const restoredCounts = (
	session: BenchSession,
	saved: ReadonlyArray<ClassCounts>
): Effect.Effect<void, SqlError> =>
	Effect.asVoid(
		session.values(
			"SELECT pg_catalog.pg_restore_relation_stats('schemaname', n.nspname::pg_catalog.text, 'relname', c.relname::pg_catalog.text, " +
				"'relpages', t.relpages, 'reltuples', t.reltuples, 'relallvisible', t.relallvisible, 'relallfrozen', t.relallfrozen) " +
				"FROM ROWS FROM (pg_catalog.unnest($1::pg_catalog.oid[]), pg_catalog.unnest($2::pg_catalog.int4[]), pg_catalog.unnest($3::pg_catalog.float4[]), pg_catalog.unnest($4::pg_catalog.int4[]), pg_catalog.unnest($5::pg_catalog.int4[])) " +
				"AS t(relation, relpages, reltuples, relallvisible, relallfrozen) " +
				"JOIN pg_catalog.pg_class AS c ON c.oid = t.relation " +
				"JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace",
			[
				textArrayLiteral(Arr.map(saved, (c) => c.relation)),
				textArrayLiteral(Arr.map(saved, (c) => c.relpages)),
				textArrayLiteral(Arr.map(saved, (c) => c.reltuples)),
				textArrayLiteral(Arr.map(saved, (c) => c.relallvisible)),
				textArrayLiteral(Arr.map(saved, (c) => c.relallfrozen))
			]
		)
	)

/**
 * `use` in a savepoint of the transaction `bare` holds open, set by `bare` itself, whose statements no savepoint of their
 * own wraps (a case's connection, test/support/substrate/substrate.ts RolledBack `connection`, releases one after each
 * statement, which would end it: RolledBack `bare`), rolled back to and released after it, so the rows it wrote, the
 * pg_class state it stood them in (statsStood) and the advice it held stand for it alone: each state of a case's tables
 * held apart from the others. An ANALYZE writes a table's pg_class counts in place (PostgreSQL 19 vacuum.c
 * vac_update_relstats, systable_inplace_update_finish), and its indexes' (analyze.c do_analyze_rel), which no rollback
 * puts back, so `tables`, every table `use` may ANALYZE, and their indexes stand at the counts they held before it once
 * it is rolled back (`restoredCounts`): their pg_statistic rows the rollback puts back, their counts the restore.
 */
export const apart = <A, E, R>(
	bare: BenchSession,
	name: string,
	tables: ReadonlyArray<string>,
	use: Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError, R> =>
	Effect.gen(function* () {
		const saved = yield* classCounts(bare, tables)
		yield* bare.values(`SAVEPOINT ${name}`, [])
		const value = yield* use
		yield* bare.values(`ROLLBACK TO SAVEPOINT ${name}`, [])
		yield* bare.values(`RELEASE SAVEPOINT ${name}`, [])
		yield* restoredCounts(bare, saved)
		return value
	})

/**
 * A load's rows standing once in their tables (storedOnce, grownBeside): its units 1 to `standing`, each written once in
 * the load's order, to be stood in each of `states` (statsStood) by its statistics alone, never by writing them again
 * (inState): a load rolled back and written again leaves each of its rows a version no later snapshot sees, which a scan
 * visits at a heap page each and EXPLAIN counts as no row (page-keys' floor case 1 read 9 pages of the 8 its plan gave,
 * 4 of them a rolled-back load's). Where `states` holds skewed, every table was ANALYZEd once, when it held its first
 * hundredth of the units, the skewed state's statistics; `created` is the counts its tables and their indexes held
 * before any of its rows was written, a new table's, which a state never ANALYZEd stands at again.
 */
export interface StoredRows<S extends PgClassState, E = SqlError, R = never> {
	readonly tables: Arr.NonEmptyReadonlyArray<string>
	readonly standing: number
	readonly load: (from: number, to: number) => Effect.Effect<void, E, R>
	readonly states: Arr.NonEmptyReadonlyArray<S>
	readonly created: ReadonlyArray<ClassCounts>
}

/**
 * The units after `standing` to `units` of `stored`'s load written beside the units standing, by `session`; where its
 * states hold skewed, each table ANALYZEd when it holds its first hundredth of `units`, if that point lies among them: a
 * table past it keeps the statistics of the hundredth it was ANALYZEd at, a prefix's still.
 */
const writtenBeside = <S extends PgClassState, E, R>(
	session: BenchSession,
	stored: Pick<StoredRows<S, E, R>, "tables" | "load" | "states">,
	standing: number,
	units: number
): Effect.Effect<void, E | SqlError, R> => {
	const prefix = Math.ceil(units / 100)
	const from = (first: number) => (first <= units ? stored.load(first, units) : Effect.void)
	const states: ReadonlyArray<PgClassState> = stored.states
	return !states.includes("skewed") || prefix <= standing
		? from(standing + 1)
		: Effect.gen(function* () {
				yield* stored.load(standing + 1, prefix)
				yield* eachTable(session, stored.tables, (t) => `ANALYZE ${t}`)
				yield* from(prefix + 1)
			})
}

/**
 * The statistics of an expression index, which ANALYZE gathers and no statistics function clears (PostgreSQL 19
 * stat_utils.c, its relkinds ANALYZE's tables'): a table whose rows stand in the skewed state and in one never ANALYZEd
 * holds none, refused where its rows are stored, so no state keeps the skewed one's.
 */
const noExpressionIndex = (
	session: BenchSession,
	tables: ReadonlyArray<string>
): Effect.Effect<void, SqlError> =>
	Effect.map(
		session.values(
			"SELECT i.indexrelid::pg_catalog.regclass::pg_catalog.text FROM pg_catalog.pg_index AS i " +
				"WHERE i.indrelid = ANY (SELECT t::pg_catalog.regclass FROM pg_catalog.unnest($1::pg_catalog.text[]) AS t) " +
				"AND i.indexprs IS NOT NULL ORDER BY 1",
			[textArrayLiteral(tables)]
		),
		(indexes) =>
			assert.deepEqual(
				indexes,
				[],
				"a table stood in the skewed state and in one never ANALYZEd has no expression index, whose statistics no state but the skewed one may keep"
			)
	)

/**
 * `load`'s units written once into its tables by `session`, to be stood in each of `states` (StoredRows), every table
 * ANALYZEd when it held its first hundredth of them where `states` holds skewed.
 */
export const storedOnce = <S extends PgClassState, E, R>(
	session: BenchSession,
	load: StateLoad<E, R>,
	states: Arr.NonEmptyReadonlyArray<S>
): Effect.Effect<StoredRows<S, E, R>, E | SqlError, R> =>
	Effect.gen(function* () {
		const stated: ReadonlyArray<PgClassState> = states
		if (stated.includes("skewed") && Arr.some(stated, (s) => s !== "skewed" && s !== "analyzed")) {
			yield* noExpressionIndex(session, load.tables)
		}
		const created = yield* classCounts(session, load.tables)
		yield* writtenBeside(session, { tables: load.tables, load: load.load, states }, 0, load.units)
		return { tables: load.tables, standing: load.units, load: load.load, states, created }
	})

/**
 * `stored`'s rows with its load's units after them to `units` written beside, each once (writtenBeside): every row of
 * the earlier units standing as it stood.
 */
export const grownBeside = <S extends PgClassState, E, R>(
	session: BenchSession,
	stored: StoredRows<S, E, R>,
	units: number
): Effect.Effect<StoredRows<S, E, R>, E | SqlError, R> =>
	Effect.as(writtenBeside(session, stored, stored.standing, units), { ...stored, standing: units })

/**
 * `stored`'s tables as new ones are to the planner, by `session`: every column statistic cleared
 * (pg_clear_attribute_stats, a transactional delete), and every count of them and of their indexes the count it held
 * before their rows were written (`created`).
 */
const statisticsCleared = <S extends PgClassState, E, R>(
	session: BenchSession,
	stored: StoredRows<S, E, R>
): Effect.Effect<void, SqlError> =>
	Effect.andThen(
		session.values(
			"SELECT pg_catalog.pg_clear_attribute_stats(n.nspname::pg_catalog.text, c.relname::pg_catalog.text, a.attname::pg_catalog.text, false) " +
				"FROM pg_catalog.unnest($1::pg_catalog.text[]) AS t JOIN pg_catalog.pg_class AS c ON c.oid = t::pg_catalog.regclass " +
				"JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace " +
				"JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped",
			[textArrayLiteral(stored.tables)]
		),
		restoredCounts(session, stored.created)
	)

/**
 * The statistics of `state` (`PgClassState`), one of `stored`'s states, stood over the rows it holds, by `session`:
 * never vacuumed, its tables' as new ones' (`statisticsCleared`: no column statistic, relpages 0, reltuples -1); counted
 * empty, those, and each table counted at its pages and no row, as the VACUUM of e1 counts it, one another session runs
 * while its load is open (`countedAt`); analyzed, ANALYZEd over every row; skewed, the statistics storedOnce left,
 * ANALYZEd at its first hundredth; large, a new table's, each counted at `largeRows` on its pages. A statistics statement
 * is no VACUUM, which no transaction may run.
 */
export const statsStood = <S extends PgClassState, E, R>(
	session: BenchSession,
	stored: StoredRows<S, E, R>,
	state: S
): Effect.Effect<void, SqlError> => {
	const standing: PgClassState = state
	switch (standing) {
		case "never vacuumed":
			return statisticsCleared(session, stored)
		case "counted empty":
			return Effect.andThen(
				statisticsCleared(session, stored),
				eachTable(session, stored.tables, (t) => countedAt(t, 0))
			)
		case "analyzed":
			return eachTable(session, stored.tables, (t) => `ANALYZE ${t}`)
		case "skewed":
			return Effect.void
		case "large":
			return Effect.andThen(
				statisticsCleared(session, stored),
				eachTable(session, stored.tables, (t) => countedAt(t, largeRows))
			)
	}
}

/**
 * `load`'s rows stored once (storedOnce) and stood in `state` (statsStood), by `session`, in the transaction it holds
 * open or each statement its own: what a case measured in one state reads.
 */
export const standIn = <E, R>(
	session: BenchSession,
	load: StateLoad<E, R>,
	state: PgClassState
): Effect.Effect<void, E | SqlError, R> =>
	Effect.flatMap(storedOnce(session, load, [state]), (stored) => statsStood(session, stored, state))

/**
 * `use` over `stored`'s rows stood in `state`, one of its states (statsStood), apart from every other state of them
 * (`apart`, in the savepoint `name` of the transaction `bare` holds open): the one way a case reads its rows in several
 * states, each a state of the same rows, none written again.
 */
export const inState = <S extends PgClassState, A, E, R, E2, R2>(
	bare: BenchSession,
	session: BenchSession,
	stored: StoredRows<S, E2, R2>,
	state: S,
	name: string,
	use: Effect.Effect<A, E, R>
): Effect.Effect<A, E | SqlError, R> =>
	apart(bare, name, stored.tables, Effect.andThen(statsStood(session, stored, state), use))

/**
 * Writes a measured window adds to a permanent table, by its quoted, qualified name: the rows it inserts and deletes, as
 * autovacuum counts them (pgstat: each insert and each delete a modification since the last analyze, each insert a row
 * since the last vacuum, each delete a dead tuple).
 */
export interface WindowWrites {
	readonly table: string
	readonly inserted: number
	readonly deleted: number
}

/** The autovacuum settings a table's decision reads, each its reloption where the table states one, else the server's. */
const autovacuumSettings = [
	"autovacuum_vacuum_threshold",
	"autovacuum_vacuum_scale_factor",
	"autovacuum_vacuum_max_threshold",
	"autovacuum_vacuum_insert_threshold",
	"autovacuum_vacuum_insert_scale_factor",
	"autovacuum_analyze_threshold",
	"autovacuum_analyze_scale_factor"
] as const

/**
 * Asserts autovacuum has nothing to do with any table of `writes` once its window's writes land, as `session` reads the
 * table now: neither a vacuum nor an analyze, either of which rewrites the table's pg_class counts in place and so makes
 * every plan over it again (PostgreSQL 19 vacuum.c vac_update_relstats, a relcache invalidation the plan cache drops its
 * plans by), a count of plans that would move with the autovacuum launcher's timing, not with grizzle's. Autovacuum's
 * own decision (autovacuum.c relation_needs_vacanalyze), each threshold read off the table's reloptions or the server's
 * settings (`autovacuumSettings`), never off constants: a vacuum where its dead tuples pass the vacuum threshold, its base
 * and its scale factor times its counted rows, capped at the maximum where one is set, or where its rows inserted since
 * its last vacuum pass the insert threshold, its base and its scale factor times its counted rows' unfrozen part, where
 * insert vacuums are on; an analyze where its modifications since its last analyze pass the analyze threshold, its base
 * and its scale factor times its counted rows; the counts pg_stat's (n_dead_tup, n_ins_since_vacuum,
 * n_mod_since_analyze), each with the window's writes beside it.
 */
export const autovacuumIdle = (
	session: BenchSession,
	writes: ReadonlyArray<WindowWrites>
): Effect.Effect<void, SqlError> =>
	Effect.forEach(
		writes,
		(w) =>
			Effect.map(
				session.values(
					"WITH o AS (SELECT r.option_name, r.option_value FROM pg_catalog.pg_class AS c " +
						"CROSS JOIN LATERAL pg_catalog.pg_options_to_table(c.reloptions) AS r " +
						"WHERE c.oid = $1::pg_catalog.text::pg_catalog.regclass) SELECT " +
						Arr.join(
							Arr.map(
								autovacuumSettings,
								(setting) =>
									`COALESCE((SELECT o.option_value FROM o WHERE o.option_name = '${setting}'), pg_catalog.current_setting('${setting}'))::pg_catalog.float8::pg_catalog.text`
							),
							", "
						) +
						", GREATEST(c.reltuples, 0::pg_catalog.float4)::pg_catalog.text, c.relpages::pg_catalog.text, c.relallfrozen::pg_catalog.text, " +
						"COALESCE(s.n_dead_tup, 0)::pg_catalog.text, COALESCE(s.n_ins_since_vacuum, 0)::pg_catalog.text, " +
						"COALESCE(s.n_mod_since_analyze, 0)::pg_catalog.text " +
						"FROM pg_catalog.pg_class AS c LEFT JOIN pg_catalog.pg_stat_all_tables AS s ON s.relid = c.oid " +
						"WHERE c.oid = $1::pg_catalog.text::pg_catalog.regclass",
					[w.table]
				),
				(rows) => {
					const row = defined(rows[0], `the autovacuum counts of ${w.table}`)
					const at = (i: number): number => Number(defined(row[i], `count ${i} of ${w.table}`))
					const [vacBase, vacScale, vacMax, insBase, insScale, anlBase, anlScale] = [
						at(0),
						at(1),
						at(2),
						at(3),
						at(4),
						at(5),
						at(6)
					] as const
					const reltuples = at(7)
					const relpages = at(8)
					const relallfrozen = at(9)
					const unfrozen =
						relpages > 0 && relallfrozen > 0 ? 1 - Math.min(relallfrozen, relpages) / relpages : 1
					const scaled = vacBase + vacScale * reltuples
					const vacuumThreshold = vacMax >= 0 ? Math.min(scaled, vacMax) : scaled
					const insertThreshold = insBase + insScale * reltuples * unfrozen
					const analyzeThreshold = anlBase + anlScale * reltuples
					const dead = at(10) + w.deleted
					const inserted = at(11) + w.inserted
					const modified = at(12) + w.inserted + w.deleted
					assert.ok(
						dead <= vacuumThreshold,
						`autovacuum vacuums ${w.table} in the window: ${dead} dead tuples past its threshold ${vacuumThreshold}`
					)
					assert.ok(
						insBase < 0 || inserted <= insertThreshold,
						`autovacuum vacuums ${w.table} in the window: ${inserted} rows inserted since its last vacuum past its threshold ${insertThreshold}`
					)
					assert.ok(
						modified <= analyzeThreshold,
						`autovacuum analyzes ${w.table} in the window: ${modified} modifications since its last analyze past its threshold ${analyzeThreshold}`
					)
				}
			),
		{ discard: true }
	)

/**
 * The replan case (e2 finding 3): each statement of `scope` PREPAREd and planned, its generic plan cached, in one
 * transaction `frame` opens as its vehicle would; then `invalidate`, which moves a table's statistics and so every plan
 * over it; then explained again by EXECUTE in a later transaction `frame` opens, as the next flight's or call's would:
 * the plan PostgreSQL replanned it by, under the advice that later transaction held. The plans are generic, as every
 * session grizzle opens plans (bench/harness/explain.ts underGenericPlans), and read with
 * pg_plan_advice.always_store_advice_details on this session alone, which records a cached plan's advice and changes no
 * plan (see the header). Every statement and the setting are released before the effect ends.
 */
export const replannedScope = (
	session: BenchSession,
	scope: LawScope,
	frame: <A, E>(use: Effect.Effect<A, E>) => Effect.Effect<A, E | SqlError>,
	invalidate: Effect.Effect<void, SqlError>
): Effect.Effect<PlannedScope, SqlError | MalformedAdvice> => {
	const named = Arr.map(scope.statements, (s, at) => ({ sql: s.sql, name: `gz_laws_replan_${at}` }))
	/** An EXECUTE of a statement: every parameter NULL, which a generic plan never reads. */
	const execute = (s: { readonly sql: string; readonly name: string }): string => {
		const highest = Arr.reduce(
			Array.from(Str.matchAll(regex("\\$([0-9]+)", "gu"))(s.sql)),
			0,
			(most, m) => Math.max(most, Number(m[1]))
		)
		return highest === 0
			? `EXECUTE ${s.name}`
			: `EXECUTE ${s.name}(${Arr.join(
					Array.from({ length: highest }, () => "NULL"),
					", "
				)})`
	}
	const planned = Effect.forEach(named, (s) =>
		Effect.andThen(
			session.values(`PREPARE ${s.name} AS ${s.sql}`, []),
			session.values(`EXPLAIN (COSTS OFF) ${execute(s)}`, [])
		)
	)
	const replanned = Effect.forEach(named, (s) =>
		Effect.flatMap(
			session.values(`EXPLAIN (PLAN_ADVICE, VERBOSE, RANGE_TABLE, FORMAT JSON) ${execute(s)}`, []),
			(rows) => Effect.fromResult(advisedPlanOf(rows[0]?.[0]))
		)
	)
	return underGenericPlans(
		session,
		Effect.acquireUseRelease(
			session.values("SET pg_plan_advice.always_store_advice_details = on", []),
			() =>
				Effect.gen(function* () {
					yield* frame(planned)
					yield* invalidate
					const plans = yield* frame(replanned)
					return { inForce: scope.advice, plans }
				}),
			() =>
				Effect.orDie(
					Effect.andThen(
						Effect.forEach(named, (s) => session.values(`DEALLOCATE ${s.name}`, [])),
						session.values("RESET pg_plan_advice.always_store_advice_details", [])
					)
				)
		)
	)
}

/** A read as the bootstrap superuser (test/support/substrate/substrate.ts SubstrateShape `superuserRead`): its rows. */
type SuperuserRead = (sql: string) => Effect.Effect<ReadonlyArray<ReadonlyArray<string | null>>>

/** The one cell of a catalog read that answers one row of one column. */
const cellOf = (rows: ReadonlyArray<ReadonlyArray<string | null>>, what: string): string =>
	defined(rows[0]?.[0] ?? undefined, what)

/**
 * The block number no page has, which ends a hash bucket's overflow chain as its last page's next block (PostgreSQL
 * 19.0, storage/block.h InvalidBlockNumber, `((BlockNumber) 0xFFFFFFFF)`), as hash_page_stats answers it.
 */
const invalidBlockNumber = 0xffffffff

/** The little-endian unsigned 16-bit word at byte `at` of a raw page read as hex (get_raw_page). */
const pageWord = (hex: string, at: number): number =>
	Number.parseInt(Str.slice(2 * at, 2 * at + 2)(hex), 16) +
	Number.parseInt(Str.slice(2 * at + 2, 2 * at + 4)(hex), 16) * 256

/**
 * The heights of the indexes `indexes` names, each qualified and quoted: its levels from root to leaf, the pages one
 * descent reads, by its access method (`heightReaders`). Each read is the bootstrap superuser's: pageinspect reads raw
 * pages, which no other role may. An index of another method has no height, and the budget refuses a scan of it.
 */
export const heightsOf = (
	read: SuperuserRead,
	indexes: ReadonlyArray<string>
): Effect.Effect<ReadonlyMap<string, number>> =>
	Effect.map(
		Effect.forEach(indexes, (index) =>
			Effect.flatMap(
				read(
					`SELECT a.amname::text FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_am AS a ON a.oid = c.relam WHERE c.oid = ${quoteString(index)}::pg_catalog.regclass`
				),
				(rows) =>
					Option.match(Rec.get(heightReaders, cellOf(rows, `the access method of ${index}`)), {
						onNone: () => Effect.succeed(Arr.empty<readonly [string, number]>()),
						onSome: (height) => Effect.map(height(read, index), (h) => [[index, h] as const])
					})
			)
		),
		(pairs) => new Map(Arr.flatten(pairs))
	)

/**
 * How an index's height is read, by its access method:
 * - `btree`: its metapage's root level plus one (pageinspect's bt_metap, in the template's pageinspect_ext);
 * - `gin`: its entry tree records no level (ginblock.h GinPageOpaqueData), so its height is the length of its leftmost
 *   path, walked from its root (GIN_ROOT_BLKNO, block 1) down each internal page's first downlink (its first line
 *   pointer's entry tuple, whose t_tid block is the child, GinGetDownlink) to a leaf (GIN_LEAF): a B-tree's every leaf
 *   is at one depth;
 * - `hash`: a lookup reads its metapage and its key's bucket page, then that bucket's overflow pages one by one, each
 *   page's next its special space's hasho_nextblkno (hash.h HashPageOpaqueData), InvalidBlockNumber ending the chain:
 *   its height is two and the longest overflow chain of any bucket, walked from each bucket page (pageinspect's
 *   hash_page_type and hash_page_stats, in the template's pageinspect_ext), the pages a lookup of the worst key reads;
 * - `gist`: a GiST tree is balanced, every leaf at one depth (gist.h, a split adds a level at the root alone) and its
 *   pages record no level, so its height is the length of its leftmost path, walked from its root (GIST_ROOT_BLKNO,
 *   block 0) down each inner page's first downlink (its first item's tuple id, whose block is the child) to a page
 *   flagged a leaf (F_LEAF), by pageinspect's gist_page_opaque_info and gist_page_items_bytea.
 */
const heightReaders: Readonly<
	Record<string, (read: SuperuserRead, index: string) => Effect.Effect<number>>
> = {
	btree: (read, index) =>
		Effect.map(
			read(`SELECT (level + 1)::text FROM pageinspect_ext.bt_metap(${quoteString(index)})`),
			(rows) => Number(cellOf(rows, `the root level of ${index}`))
		),
	hash: (read, index) => {
		const page = (block: string) =>
			`pageinspect_ext.get_raw_page(${quoteString(index)}, (${block})::pg_catalog.int8)`
		return Effect.map(
			read(
				"WITH RECURSIVE buckets AS (SELECT b FROM pg_catalog.generate_series(1::pg_catalog.int8, " +
					`pg_catalog.pg_relation_size(${quoteString(index)}::pg_catalog.regclass) / pg_catalog.current_setting('block_size')::pg_catalog.int8 - 1) AS b ` +
					`WHERE pageinspect_ext.hash_page_type(${page("b")}) = 'bucket'), ` +
					`chain(next, overflow) AS (SELECT (pageinspect_ext.hash_page_stats(${page("b")})).hasho_nextblkno, 0 FROM buckets ` +
					`UNION ALL SELECT (pageinspect_ext.hash_page_stats(${page("next")})).hasho_nextblkno, overflow + 1 FROM chain ` +
					`WHERE next <> ${String(invalidBlockNumber)}) ` +
					"SELECT (2 + COALESCE(pg_catalog.max(overflow), 0))::text FROM chain"
			),
			(rows) => Number(cellOf(rows, `the longest overflow chain of ${index}`))
		)
	},
	gist: (read, index) => {
		const page = (block: string) =>
			`pageinspect_ext.get_raw_page(${quoteString(index)}, (${block})::pg_catalog.int8)`
		const leaf = (block: string) =>
			`'leaf' = ANY ((pageinspect_ext.gist_page_opaque_info(${page(block)})).flags)`
		return Effect.map(
			read(
				`WITH RECURSIVE walk(block, depth, leaf) AS (SELECT 0::pg_catalog.int8, 1, ${leaf("0")} ` +
					`UNION ALL SELECT d.child, w.depth + 1, ${leaf("d.child")} FROM walk AS w CROSS JOIN LATERAL ` +
					"(SELECT ((i.ctid::pg_catalog.text::pg_catalog.point)[0])::pg_catalog.int8 AS child " +
					`FROM pageinspect_ext.gist_page_items_bytea(${page("w.block")}) AS i ORDER BY i.itemoffset LIMIT 1) AS d ` +
					"WHERE NOT w.leaf) SELECT pg_catalog.max(walk.depth)::text FROM walk"
			),
			(rows) => Number(cellOf(rows, `the leftmost path of ${index}`))
		)
	},
	gin: (read, index) => {
		const walk = (block: number, above: number): Effect.Effect<number> =>
			Effect.flatMap(
				read(
					`SELECT pg_catalog.encode(pageinspect_ext.get_raw_page(${quoteString(index)}, ${block}), 'hex')`
				),
				(rows) => {
					const hex = cellOf(rows, `page ${block} of ${index}`)
					const flags = pageWord(hex, Str.length(hex) / 2 - 2)
					const item = pageWord(hex, 24) & 0x7fff
					const child = pageWord(hex, item) * 65_536 + pageWord(hex, item + 2)
					return (flags & 0x02) === 0 ? walk(child, above + 1) : Effect.succeed(above + 1)
				}
			)
		return walk(1, 0)
	}
}

/** What a node read beyond its children: its own shared buffers. */
const ownPages = (n: PlanNode): number =>
	n.buffers.sharedHit +
	n.buffers.sharedRead -
	Arr.reduce(n.children, 0, (sum, c) => sum + c.buffers.sharedHit + c.buffers.sharedRead)

/** What a scan's budget reads: the node, each index's height and each table's current pages. */
interface BudgetFacts {
	readonly node: PlanNode
	readonly heights: ReadonlyMap<string, number>
	readonly pages: ReadonlyMap<string, number>
}

/** The rows a scan's index condition or table read selected, over all of its loops: those it returned and filtered. */
const selectedRows = (n: PlanNode): number => (n.actualRows + n.rowsRemovedByFilter) * n.actualLoops

/** A scan past `bound` pages, the problem it is, after the node's name; none within it. */
const pastBound = (n: PlanNode, bound: number, what: string): ReadonlyArray<string> => {
	const read = ownPages(n)
	return read <= bound ? [] : [` read ${read} pages, past ${bound} (${what})`]
}

/**
 * An index scan's budget: at most one descent an evaluation, unless its index condition binds an array (`= ANY`), each
 * of its index's height; then each row its index condition selected, its leaf entry and its heap tuple for an index
 * scan, its leaf entry for an index-only scan, beside its heap fetches and a visibility map page a descent, and a
 * posting page a tuple id a bitmap index scan returns, whose heap its Bitmap Heap Scan reads.
 */
const indexBudget =
	(leafAndHeap: (n: PlanNode, rows: number, searches: number) => Option.Option<number>) =>
	(facts: BudgetFacts): ReadonlyArray<string> => {
		const n = facts.node
		const rows = selectedRows(n)
		return Option.match(
			Option.all({
				searches: n.indexSearches,
				height: Option.flatMap(n.index, (index) => Option.fromNullishOr(facts.heights.get(index)))
			}),
			{
				onNone: () => [" read an index of no known height, or printed no Index Searches"],
				onSome: ({ searches, height }) =>
					Option.match(leafAndHeap(n, rows, searches), {
						onNone: () => [" printed no Heap Fetches"],
						onSome: (pages) => [
							...(Option.exists(n.indexCond, Str.includes("= ANY (")) || searches <= n.actualLoops
								? []
								: [` descended ${searches} times over ${n.actualLoops} evaluations`]),
							...pastBound(
								n,
								searches * height + pages,
								`${searches} descents of ${height} pages and ${rows} rows`
							)
						]
					})
			}
		)
	}

/** The scans the budget bounds, by node type, each its budget (see the header); any other node reads no table itself. */
const scanBudgets: Readonly<Record<string, (facts: BudgetFacts) => ReadonlyArray<string>>> = {
	"Index Scan": indexBudget((_, rows) => Option.some(2 * rows)),
	"Index Only Scan": indexBudget((n, rows, searches) =>
		Option.map(n.heapFetches, (fetched) => rows + fetched + searches)
	),
	"Seq Scan": (facts) =>
		Option.match(
			Option.flatMap(qualifiedRelation(facts.node), (relation) =>
				Option.fromNullishOr(facts.pages.get(relation))
			),
			{
				onNone: () => [" scans a relation of no known pages"],
				onSome: (pages) =>
					pastBound(
						facts.node,
						facts.node.actualLoops * pages,
						`${facts.node.actualLoops} reads of its ${pages} pages`
					)
			}
		),
	"Tid Scan": (facts) =>
		pastBound(
			facts.node,
			selectedRows(facts.node) + facts.node.actualLoops,
			`${selectedRows(facts.node)} rows by their ids`
		),
	"Bitmap Index Scan": indexBudget((n) => Option.some(n.actualRows * n.actualLoops)),
	"Bitmap Heap Scan": (facts) =>
		Option.match(facts.node.heapBlocks, {
			onNone: () => [" printed no Heap Blocks"],
			onSome: ({ exact, lossy }) => [
				...(lossy === 0 ? [] : [` held ${lossy} heap blocks lossily, its bitmap past work_mem`]),
				...pastBound(facts.node, exact + lossy, `${exact + lossy} heap blocks`)
			]
		})
}

/**
 * The budget over one executed plan (EXPLAIN (ANALYZE, BUFFERS) of a statement under its advice, on filled data): each
 * scan reads within the pages its plan gives (see the header), each index scan descending at most once an evaluation
 * unless its index condition binds an array (`= ANY`), each descent of `heights[index]` pages; `pagesOf` a table's
 * current pages. The problems: none where the plan holds its budget.
 */
export const budgetOver = (
	label: string,
	plan: PlanNode,
	heights: ReadonlyMap<string, number>,
	pages: ReadonlyMap<string, number>,
	catalog: ReadonlySet<string>
): ReadonlyArray<string> =>
	Arr.flatMap([...planNodes(plan)], (n) =>
		Option.exists(n.alias, (a) => catalog.has(a))
			? []
			: Option.match(Rec.get(scanBudgets, n.nodeType), {
					onNone: () => [],
					onSome: (bound) =>
						Arr.map(
							bound({ node: n, heights, pages }),
							(problem) => `${label}: its ${scanText(n)}${problem}`
						)
				})
	)

/** A scan as a budget's problem names it: its type, its occurrence's alias, its index and its index condition. */
const scanText = (n: PlanNode): string =>
	`${n.nodeType}${Option.match(n.alias, { onNone: () => "", onSome: (a) => ` of ${a}` })}${Option.match(
		n.index,
		{ onNone: () => "", onSome: (i) => ` using ${i}` }
	)}${Option.match(n.indexCond, { onNone: () => "", onSome: (c) => ` (${c})` })}`

/** A scan's relation, qualified by the schema VERBOSE prints beside it, as a regclass reads it. */
const qualifiedRelation = (n: PlanNode): Option.Option<string> =>
	Option.map(
		Option.all({ schema: n.schema, relation: n.relation }),
		({ schema, relation }) => `${quoteIdent(schema)}.${quoteIdent(relation)}`
	)

/** A scan's index, qualified by its relation's schema, as a regclass reads it. */
const qualifiedIndex = (n: PlanNode): Option.Option<string> =>
	Option.map(
		Option.all({ schema: n.schema, index: n.index }),
		({ schema, index }) => `${quoteIdent(schema)}.${quoteIdent(index)}`
	)

/**
 * The budget over `plan`, a statement EXPLAIN (ANALYZE, BUFFERS, VERBOSE) ran on filled data in the transaction
 * `session` holds open, each problem named after `label`: every index it reads its height (`heightsOf`, by `read`, the
 * bootstrap superuser's), every table it reads whole its current pages (pg_relation_size), and the problems
 * `budgetOver` finds.
 */
export const budgetOfPlan = (
	session: BenchSession,
	read: SuperuserRead,
	label: string,
	plan: PlanNode,
	catalog: ReadonlySet<string>
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
	Effect.gen(function* () {
		const nodes = [...planNodes(plan)]
		const indexed = Arr.flatMap(nodes, (n) =>
			Option.match(Option.all({ name: n.index, qualified: qualifiedIndex(n) }), {
				onNone: () => [],
				onSome: (i) => [i]
			})
		)
		const heights = yield* heightsOf(read, Arr.dedupe(Arr.map(indexed, (i) => i.qualified)))
		const tables = Arr.dedupe(
			Arr.flatMap(nodes, (n) =>
				n.nodeType === "Seq Scan" ? Option.toArray(qualifiedRelation(n)) : []
			)
		)
		const sized = yield* Effect.forEach(tables, (t) =>
			Effect.map(
				session.values(
					"SELECT (pg_catalog.pg_relation_size($1::text::pg_catalog.regclass) / pg_catalog.current_setting('block_size')::pg_catalog.int8)::pg_catalog.int8",
					[t]
				),
				(rows) => [t, Number(rows[0]?.[0])] as const
			)
		)
		const byName = new Map(
			Arr.flatMap(indexed, (i) =>
				Option.match(Option.fromNullishOr(heights.get(i.qualified)), {
					onNone: () => [],
					onSome: (h) => [[i.name, h] as const]
				})
			)
		)
		return budgetOver(label, plan, byName, new Map(sized), catalog)
	})

/**
 * The budget held over each statement of `scope` that reads no parameter, a query (`SELECT`) run on filled data as its
 * vehicle's advice holds it, in the transaction `session` holds open (EXPLAIN (ANALYZE, BUFFERS, VERBOSE, TIMING OFF,
 * SETTINGS, FORMAT JSON), bench/harness/explain.ts explain), each plan's problems `budgetOfPlan` finds. A statement
 * that reads parameters waits on the values a caller binds; its budget is its caller's. A capture's statements read
 * the transition tables of the statement that fires it, the rows that statement wrote, which exist inside its trigger
 * alone (RoutineFiring `capture`): their budget is the firing write's, held where a test writes.
 */
export const budgetOfScope = (
	session: BenchSession,
	read: SuperuserRead,
	scope: LawScope
): Effect.Effect<ReadonlyArray<string>, SqlError | MalformedPlan> =>
	Effect.gen(function* () {
		if (scope.vehicle.kind === "routine" && scope.vehicle.fires.kind === "capture") {
			return []
		}
		yield* holdVehicle(session, scope)
		const problems: Array<string> = []
		for (const s of scope.statements) {
			if (Str.includes("$")(s.sql) || !Str.startsWith("SELECT")(s.sql)) {
				continue
			}
			const run = yield* explain(session, s.sql, [], {
				serialize: { kind: "off" },
				wal: false,
				verbose: true
			})
			for (const problem of yield* budgetOfPlan(
				session,
				read,
				`${scope.label}, ${s.label}`,
				run.plan,
				new Set(scope.catalog)
			)) {
				problems.push(problem)
			}
		}
		return problems
	})
