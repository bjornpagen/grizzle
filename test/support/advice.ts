/**
 * The plan laws' one harness (README "Plan advice"): every statement grizzle emits carries the plan its compiler
 * proved to PostgreSQL 19 as plan advice (contrib/pg_plan_advice, sql/advice.ts printAdvice), and these are the laws
 * that hold it, each read off PostgreSQL itself.
 *
 * - **Law 1, plan identity.** Planned under its scope's advice, in force as production puts it in force (`Vehicle`), a
 *   statement's generated advice is the advice grizzle carries for it, atom for atom; every atom it carries is reported
 *   `matched`, with no flag; and no node is disabled. The comparison is CARRY-CONTRACT §3's: a generated atom whose
 *   targets grizzle named (an alias the scope minted, at the top level or a level it minted) is one of the carried, and
 *   every other is a NO_GATHER of a relation at a level PostgreSQL named (a sublink's one item, `"*RESULT*"`). The laws
 *   cover every statement over grizzle's own relations: a read of PostgreSQL's system catalogs (sql/catalog.ts) stays
 *   cost-chosen, with real statistics and no proof of grizzle's, as does a consumer's hand-written migration DML, which
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
 * - **Law 3, scope.** Every name a scope mints is minted once, and every atom of the scope's advice is matched in exactly
 *   one of its statements: PostgreSQL applies one advice string to every statement it plans under it, so an alias two
 *   statements share meets the other's items.
 * - **The budget.** On filled data a statement reads within the pages its plan gives: each scan of an index its
 *   descents times the index's height, and two pages a row its index condition selects (its leaf entry and its heap
 *   tuple), an index-only scan one and its heap fetches; a bitmap read's index scan its descents times its GIN's
 *   height and a posting page a tuple id it returns, its heap scan the heap blocks it read, none of them lossy (a lossy
 *   block is a bitmap past work_mem, a failure); each whole read its table's pages; and no scan descends more than once
 *   an evaluation. Counted, never timed.
 *
 * Every plan is PostgreSQL's own: EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON) of the statement,
 * planned fresh under the advice in force, generic as every session grizzle opens plans (physical/ddl/roles.ts
 * genericPlans), which prints the advice that reproduces its plan and its feedback on each supplied atom. The replan
 * case alone reads a cached plan, which PostgreSQL records advice for only under
 * pg_plan_advice.always_store_advice_details: the harness sets it on its own observing session there, an observation
 * setting that changes no plan (pgpa_planner.c builds no trove unless advice is supplied). No planner setting is set.
 *
 * The tables a law reads stand in a pg_class state (`PgClassState`), each as production leaves one: never vacuumed;
 * counted empty, pg_class holding its pages and no row, as a VACUUM another session runs while its load is open counts
 * it (e1's tie, stated as that VACUUM states it); analyzed; skewed, analyzed over its first rows, then filled; and large,
 * pg_class counting a million rows on its pages, the scale of edullm's 1x tables.
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
import type { StatementSpec } from "#compiler/ir/products.ts"
import type { IndexRef, IndexResolver } from "#compiler/physical/indexes/ref.ts"
import type { Installation } from "#compiler/physical/install/compile.ts"
import {
	type InstalledSource,
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
import type { EmittedSql, ObjectName } from "#compiler/sql/ast.ts"
import { joinPlans, levelItems, type ReadPlan, resolvePlan } from "#compiler/sql/plan.ts"
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
 * One node of a plan as the laws read it: its type, the alias of the relation occurrence it scans (none where it scans
 * none), the index it reads, whether the planner disabled it (`Disabled: true`, a path advice forbade that nothing
 * could replace), and its conditions' columns: its index condition's (a TID scan's TID condition among them), its
 * filter's, and a join's, the Join Filter, Hash Cond and Merge Cond it pairs its sides by, with each equality its Join
 * Filter states between two columns; and whether it scans a stored relation. A Bitmap Heap Scan's Recheck Cond repeats
 * its Bitmap Index Scan's index condition, and is no filter.
 */
export interface LawNode {
	readonly nodeType: string
	readonly alias: Option.Option<string>
	readonly index: Option.Option<string>
	readonly disabled: boolean
	readonly indexCond: ReadonlyArray<ColumnRef>
	readonly filter: ReadonlyArray<ColumnRef>
	readonly joined: ReadonlyArray<ColumnRef>
	readonly equated: ReadonlyArray<readonly [ColumnRef, ColumnRef]>
	readonly stored: boolean
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
const childrenOf = (o: Json): ReadonlyArray<LawNode> => {
	const plans = o["Plans"]
	if (plans === undefined) {
		return []
	}
	return Arr.isArray(plans)
		? Arr.map(plans, (p: unknown) => (isJson(p) ? lawNodeOf(p) : malformed("a child plan")))
		: malformed("Plans is not a list")
}

const lawNodeOf = (o: Json): LawNode => ({
	nodeType: Option.getOrElse(textAt(o, "Node Type"), () => malformed("a node with no Node Type")),
	alias: textAt(o, "Alias"),
	index: textAt(o, "Index Name"),
	disabled: o["Disabled"] === true,
	indexCond: columnsAt(o, ["Index Cond", "TID Cond"]),
	filter: columnsAt(o, ["Filter"]),
	joined: columnsAt(o, ["Join Filter", "Hash Cond", "Merge Cond"]),
	equated: Option.match(textAt(o, "Join Filter"), { onNone: () => [], onSome: equalitiesIn }),
	stored: o["Relation Name"] !== undefined,
	children: childrenOf(o)
})

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
			root: isJson(plan) ? lawNodeOf(plan) : malformed("an EXPLAIN cell with no Plan"),
			generated: Result.getOrElse(
				atomsOf(Option.getOrElse(textAt(top, "Generated Plan Advice"), () => "")),
				(e) => malformed(e.message)
			),
			supplied: Option.map(textAt(top, "Supplied Plan Advice"), suppliedOf)
		}
	})

/** Every node of a plan, its root first. */
function* lawNodes(n: LawNode): Generator<LawNode> {
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
	| { readonly kind: "routine"; readonly routine: ObjectName }

/** A read the binding law judges: the alias of its relation's occurrence and the columns its index condition binds. */
export interface BoundRead {
	readonly alias: string
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
 * An advice scope as the laws read it (CARRY-CONTRACT §4, sql/naming.ts AdviceScope): its label; the advice grizzle
 * carries for it; its plan's names, each item's alias once for each item and each level it named once for each level;
 * its reads, each by its alias with the columns its index condition binds, a TID scan's its ctid; its statements; and
 * its vehicle.
 */
export interface LawScope {
	readonly label: string
	readonly advice: string
	readonly aliases: ReadonlyArray<string>
	readonly levels: ReadonlyArray<string>
	readonly reads: ReadonlyArray<BoundRead>
	readonly statements: Arr.NonEmptyReadonlyArray<ScopeStatement>
	readonly vehicle: Vehicle
}

/**
 * The names and reads of a plan of one scope (sql/plan.ts ReadPlan), as a LawScope holds them: each item's alias, each
 * named level's name, and each read's binding, an index or bitmap read's bound columns and a TID read's ctid.
 */
export const planFacts = (
	plan: ReadPlan<IndexRef>
): Pick<LawScope, "aliases" | "levels" | "reads"> => ({
	aliases: Arr.flatMap(plan.levels, (level) => Arr.map(levelItems(level), (item) => item.alias)),
	levels: Arr.flatMap(plan.levels, (level) =>
		level.name.kind === "named" ? [level.name.name] : []
	),
	reads: Arr.flatMap(plan.levels, (level) =>
		Arr.flatMap(levelItems(level), (item): ReadonlyArray<BoundRead> => {
			switch (item.scan.kind) {
				case "index":
				case "bitmap":
					return [{ alias: item.alias, bound: item.scan.bound, stores: item.scan.index.stores }]
				case "tid":
					return [{ alias: item.alias, bound: ["ctid"], stores: ["ctid"] }]
				case "seq":
				case "rows":
					return []
			}
		})
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
						advice: printAdvice(routine.plan),
						...planFacts(routine.plan),
						statements: [first, ...rest],
						vehicle: { kind: "routine", routine: routine.fn }
					}
				]
	})

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
 * A read as a served Db of `role` runs it: compiled at the call as the role compiles every read no one compiled ahead
 * (test/support/served-role.ts servedRoleContext, adapter/served/role.ts RoleContext `compile`), as generate compiles a
 * workload's rows member (adapter/served/forms.ts compileRowsForm: the snapshot context, rows, the transaction's
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
 * A page as a served Db of `role` runs it (adapter/served/forms.ts compileReadForm's page): its ordered query compiled
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
			const ours = Arr.filter(plan.generated, (a) => namedBy(minted, a))
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
				...Arr.flatMap(plan.generated, (a) =>
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
 * scan of its occurrence among the scope's statements, never in that scan's filter, and none it binds is in a join's
 * condition; and no join's
 * filter equates a column of a stored read with another's, a binding the statement's shape lost to a plain join, which
 * the binder makes a probe (sql/bind.ts: a stored table an earlier item binds is never a set join's inner).
 */
const binding = (scope: LawScope, planned: PlannedScope): ReadonlyArray<string> => {
	const nodes = Arr.flatMap(planned.plans, (p) => [...lawNodes(p.root)])
	const names = (refs: ReadonlyArray<ColumnRef>, alias: string, column: string): boolean =>
		Arr.some(refs, (r) => r.alias === alias && r.column === column)
	const storedAliases = new Set(
		Arr.flatMap(nodes, (n) => (n.stored ? Option.toArray(n.alias) : []))
	)
	const lost = Arr.flatMap(nodes, (n) =>
		Arr.flatMap(n.equated, ([a, b]) =>
			storedAliases.has(a.alias) || storedAliases.has(b.alias)
				? [
						`${scope.label}: its ${nodeText(n)} filters ${a.alias}.${a.column} = ${b.alias}.${b.column} after joining, a binding of a stored read no index condition holds`
					]
				: []
		)
	)
	return [
		...lost,
		...Arr.flatMap(scope.reads, (read) => {
			const scans = Arr.filter(
				nodes,
				(n) =>
					Option.contains(n.alias, read.alias) &&
					Str.endsWith(" Scan")(n.nodeType) &&
					n.nodeType !== "Subquery Scan"
			)
			const [scan, ...more] = scans
			if (scan === undefined || more.length > 0) {
				return [`${scope.label}: the read ${read.alias} is scanned ${scans.length} times`]
			}
			const bitmaps = Arr.filter(scan.children, (c) => c.nodeType === "Bitmap Index Scan")
			const [bitmap, ...others] = bitmaps
			if (
				scan.nodeType === "Bitmap Heap Scan" &&
				(bitmap === undefined || others.length > 0 || scan.children.length !== 1)
			) {
				return [
					`${scope.label}: the read ${read.alias} is a ${nodeText(scan)} over ${scan.children.length} nodes, where one Bitmap Index Scan serves it`
				]
			}
			const indexCond = bitmap === undefined ? scan.indexCond : bitmap.indexCond
			return Arr.flatMap(read.bound, (column) => {
				const stored = read.stores.includes(column)
				const where = [
					...(!stored || names(indexCond, read.alias, column)
						? []
						: ["outside its index condition"]),
					...(stored && names(scan.filter, read.alias, column) ? ["in its filter"] : []),
					...(Arr.some(nodes, (n) => names(n.joined, read.alias, column))
						? ["in a join's condition"]
						: [])
				]
				return where.length === 0
					? []
					: [
							`${scope.label}: ${read.alias}.${column} is bound, read ${Arr.join(where, " and ")} of its ${nodeText(scan)}`
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
 * Law 3 over `scope`, `planned`: no two items of its plan share an alias and no two of its levels a name, and every atom
 * of its advice is matched in exactly one of its statements.
 */
const scopeLaw = (scope: LawScope, planned: PlannedScope): ReadonlyArray<string> => [
	...repeated(scope.label, "items", scope.aliases),
	...repeated(scope.label, "levels", scope.levels),
	...Arr.flatMap(Arr.dedupe(Arr.map(carriedAtoms(scope.advice), (a) => a.text)), (t) => {
		const matchedIn = Arr.flatMap(
			Arr.zip<ScopeStatement, AdvisedPlan>(scope.statements, planned.plans),
			([s, p]) =>
				Arr.some(suppliedIn(p), (x) => x.atom.text === t && x.feedback.match === "matched")
					? [s.label]
					: []
		)
		return matchedIn.length === 1
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
 * OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON) of the statement's text, run as dynamic SQL, so its typed placeholders are
 * the generic plan's own parameters. Sent over the extended protocol, the one every test session speaks, a text with
 * `$n` in it asks the call for those values, and EXPLAIN (GENERIC_PLAN) plans at them.
 */
const lawPlanner =
	"CREATE OR REPLACE FUNCTION pg_temp.gz_laws_plan(statement text) RETURNS json LANGUAGE plpgsql AS $$ " +
	"DECLARE plan json; BEGIN EXECUTE 'EXPLAIN (GENERIC_PLAN, COSTS OFF, PLAN_ADVICE, VERBOSE, FORMAT JSON) ' || statement INTO plan; RETURN plan; END $$"

/** A statement's plan for the laws, through the session's planner function (`lawPlanner`). */
const lawPlan = (session: BenchSession, sql: string) =>
	Effect.flatMap(session.values("SELECT pg_temp.gz_laws_plan($1::text)::text", [sql]), (rows) =>
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
		yield* session.values(lawPlanner, [])
		const plans = yield* Effect.forEach(scope.statements, (s) => lawPlan(session, s.sql))
		return { inForce, plans }
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
 * included, each call in the transaction its session holds open.
 */
export interface StateLoad {
	readonly tables: Arr.NonEmptyReadonlyArray<string>
	readonly units: number
	readonly load: (from: number, to: number) => Effect.Effect<void, SqlError>
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
 * `load` run on `session`, in the transaction it holds open, and its tables stood in `state` (`PgClassState`). A
 * counted-empty table is counted as the VACUUM of e1 counts it, one another session runs while its load is open: its
 * pages, and no row, the load's rows in progress to that VACUUM; a large one at `largeRows` on its pages.
 */
export const standIn = (
	session: BenchSession,
	load: StateLoad,
	state: PgClassState
): Effect.Effect<void, SqlError> => {
	const all = load.load(1, load.units)
	switch (state) {
		case "never vacuumed":
			return all
		case "counted empty":
			return Effect.andThen(
				all,
				eachTable(session, load.tables, (t) => countedAt(t, 0))
			)
		case "analyzed":
			return Effect.andThen(
				all,
				eachTable(session, load.tables, (t) => `ANALYZE ${t}`)
			)
		case "skewed": {
			const prefix = Math.ceil(load.units / 100)
			return Effect.gen(function* () {
				yield* load.load(1, prefix)
				yield* eachTable(session, load.tables, (t) => `ANALYZE ${t}`)
				if (prefix < load.units) {
					yield* load.load(prefix + 1, load.units)
				}
			})
		}
		case "large":
			return Effect.andThen(
				all,
				eachTable(session, load.tables, (t) => countedAt(t, largeRows))
			)
	}
}

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
			session.values(`EXPLAIN (PLAN_ADVICE, VERBOSE, FORMAT JSON) ${execute(s)}`, []),
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
 *   is at one depth.
 */
const heightReaders: Readonly<
	Record<string, (read: SuperuserRead, index: string) => Effect.Effect<number>>
> = {
	btree: (read, index) =>
		Effect.map(
			read(`SELECT (level + 1)::text FROM pageinspect_ext.bt_metap(${quoteString(index)})`),
			(rows) => Number(cellOf(rows, `the root level of ${index}`))
		),
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
	pages: ReadonlyMap<string, number>
): ReadonlyArray<string> =>
	Arr.flatMap([...planNodes(plan)], (n) =>
		Option.match(Rec.get(scanBudgets, n.nodeType), {
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
	plan: PlanNode
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
		return budgetOver(label, plan, byName, new Map(sized))
	})

/**
 * The budget held over each statement of `scope` that reads no parameter, a query (`SELECT`) run on filled data as its
 * vehicle's advice holds it, in the transaction `session` holds open (EXPLAIN (ANALYZE, BUFFERS, VERBOSE, TIMING OFF,
 * SETTINGS, FORMAT JSON), bench/harness/explain.ts explain), each plan's problems `budgetOfPlan` finds. A statement
 * that reads parameters waits on the values a caller binds; its budget is its caller's.
 */
export const budgetOfScope = (
	session: BenchSession,
	read: SuperuserRead,
	scope: LawScope
): Effect.Effect<ReadonlyArray<string>, SqlError | MalformedPlan> =>
	Effect.gen(function* () {
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
				run.plan
			)) {
				problems.push(problem)
			}
		}
		return problems
	})
