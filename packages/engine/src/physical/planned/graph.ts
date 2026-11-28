/**
 * The queries PostgreSQL plans behind an installation's statements: every SPI query and expression a PL/pgSQL body
 * plans, every query a referential action plans, and what reaches each, as data a served compile walks from a call's
 * own statements (program/planned.ts) to bound the pg_stat_statements entries one call makes, read off the installation's
 * own statements (physical/install/compile.ts Installation `statements`), never off a printed text.
 *
 * pg_stat_statements keys an entry by its user, its database, its query id and whether it ran at the top level (REL_19_0
 * contrib/pg_stat_statements pgssHashKey). A query id is the jumble of the parsed query (src/backend/nodes/
 * queryjumblefuncs.c): a constant's value is none of it, its type is; a parameter's number and type are; a relation's
 * alias is, its OID is not (parsenodes.h RangeTblEntry, `relid` query_jumble_ignore, `eref` jumbled as its alias). So the
 * graph names each query by an identity two queries share only where they share a query id:
 *
 * - **A PL/pgSQL query** is its piece of the body as the function's printed form holds it (sql/print-once.ts
 *   printedFunction), every literal in it replaced by one of the same printed type (`canonicalLiteral`), under the
 *   function's frame where the piece reads one of its variables (a PL/pgSQL variable is a parameter of its datum's number
 *   and type, which the frame fixes, pl_comp.c do_compile) and the trigger's relation where it reads a row of it (a
 *   transition table's and NEW's columns are the relation's). Two pieces of one identity print one text under one frame,
 *   so they are one query id; two of different identities may still be one (a relation of another name under the same
 *   alias), which the bound counts twice: it is an upper bound.
 * - **A referential action's query** is its foreign key's kind of query and the two sides it reads (REL_19_0
 *   src/backend/utils/adt/ri_triggers.c, each query's text built from them alone).
 *
 * What a body plans is what it can run: a trigger function's body for the event that fires it, an IF on TG_OP decided by
 * the event (`decided`), every other branch whole, a RAISE's options among them, since a refusal plans them as it runs.
 * A PL/pgSQL RETURN of one variable plans nothing (pl_gram.y make_return_stmt `retvarno`). An SQL function's or an SQL
 * constant's body plans nothing pg_stat_statements records: PostgreSQL inlines it, or runs its stored query, which is
 * parsed with no query id (plancache.c CreateCachedPlanForQuery over `prosqlbody`, parsenodes.h Query `queryId`
 * read_as(0)). A foreign key's check of an inserted or updated row probes the referenced index and plans no query
 * (ri_triggers.c ri_FastPathCheck), but for a PERIOD key's; a NO ACTION check of a removed or re-keyed referenced row
 * plans two, ri_Check_Pk_Match's and its own, a PERIOD key's one; an ON UPDATE CASCADE one, which fires the referencing
 * table's update.
 */
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { nominal } from "#compiler/core/brand.ts"
import { canonicalTextOf, unwrap } from "#compiler/core/canonical.ts"
import { type ContentKey, contentCensus, contentDigest } from "#compiler/core/identity.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import {
	addedColumn,
	type ColumnDef,
	type CreateConstant,
	type CreateDomain,
	type Delete,
	type Expr,
	type ForeignKey,
	type Insert,
	type LiteralValue,
	type Merge,
	type ObjectName,
	type PlFunction,
	type PlStatement,
	type SqlStatement,
	type TableConstraint,
	tableConstraints,
	type Update
} from "#compiler/sql/ast.ts"
import { printedFunction } from "#compiler/sql/print-once.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { type Reach, ReachOf, type WriteEvent } from "#compiler/sql/reach.ts"
import { generationColumns, identityHooks, Transform } from "#compiler/sql/transform.ts"

/** A trigger event's kind: what fires a trigger, a referential action among them. */
export type PlannedEventKind = WriteEvent["kind"]

/**
 * What a piece of the installation reaches as it runs, as the graph records it: the queries it plans itself, by their
 * numbers in the graph's order of identities (see the header), its RAISEs' apart; and the functions it calls, the
 * relations it reads, the types it casts to and the writes it makes, each by its printed name (sql/reach.ts).
 */
export interface PlannedReach {
	readonly queries: ReadonlyArray<number>
	/**
	 * The queries of each RAISE it may run, its options' expressions, by RAISE: PL/pgSQL plans them only as the RAISE runs,
	 * and the first RAISE a call runs ends it (no body grizzle installs catches one), so a call plans one RAISE's at most.
	 */
	readonly raises: ReadonlyArray<ReadonlyArray<number>>
	readonly calls: ReadonlyArray<string>
	readonly reads: ReadonlyArray<string>
	readonly types: ReadonlyArray<string>
	readonly writes: ReadonlyArray<PlannedWrite>
}

/** A write a piece makes: its relation's printed name, and the event it fires there (sql/reach.ts WriteEvent). */
export interface PlannedWrite {
	readonly relation: string
	readonly event: WriteEvent
}

/**
 * A reach's key in the graph's table of reaches (PlannedGraph `reaches`): the digest of its content, rendered as every
 * hashed name grizzle mints renders its digest (core/identity.ts contentDigest, digestChars characters of base32), so
 * each reach the installation holds is stored once, however many functions, triggers, relations and domains reach the
 * same, and a key names one reach where its census holds (contentCensus, refusing two of one key as DigestCollision).
 * Minted here alone (`reachKey`).
 */
export type PlannedReachKey = string & { readonly [plannedReachKeyBrand]: true }
declare const plannedReachKeyBrand: unique symbol

const mintReachKey = nominal<string, PlannedReachKey>()

/** The key of the reach whose canonical text is `canonical` (PlannedReachKey). */
const reachKey = (canonical: string): PlannedReachKey => mintReachKey(contentDigest(canonical))

/**
 * An installed function as a call of it runs: `definer`, its body run as its owner, the installation's, as every law
 * function and SQL function runs; `invoker`, its body run as its caller, as a constant runs, a row function among them;
 * each with the key of what its body reaches; or `declared`, an application's function, whose body grizzle never reads
 * (physical/ddl/functions.ts), so what it plans is no part of the graph.
 */
export type PlannedFunction =
	| { readonly kind: "definer" | "invoker"; readonly reach: PlannedReachKey }
	| { readonly kind: "declared" }

/**
 * A trigger PostgreSQL fires on a relation, a referential action's among them: the event that fires it, the columns
 * whose assignment by an update fires it (each column it names, and every column a generated one among them reads; none
 * for every update), whether it fires at the end of its statement or at COMMIT, and what it reaches there, run as the
 * installation's owner.
 */
export interface PlannedTrigger {
	readonly event: PlannedEventKind
	readonly columns: ReadonlyArray<string>
	readonly fires: "immediate" | "deferred"
	readonly reach: PlannedReachKey
}

/**
 * A relation the installation holds as a statement meets it: what a role's read of it reaches beyond its rows (`read`: a
 * view's query and a table's policies), what a row written into it reaches as its writer (`row`: its CHECKs, its
 * generations and its columns' domains), and its triggers.
 */
export interface PlannedRelation {
	readonly read: PlannedReachKey
	readonly row: PlannedReachKey
	readonly triggers: ReadonlyArray<PlannedTrigger>
}

/**
 * The installation's planned queries as data (see the header): every reach its functions, triggers, relations and
 * domains reach, once, by its key (PlannedReachKey); each function by its printed name, each relation a statement may
 * read or write by its printed name, the rule judge's log among them, and each domain by its printed name with the key of what its checks reach. On qti-pie's pantry 6,852 references name 3,988 reaches.
 */
export interface PlannedGraph {
	readonly reaches: Readonly<Record<string, PlannedReach>>
	readonly functions: Readonly<Record<string, PlannedFunction>>
	readonly relations: Readonly<Record<string, PlannedRelation>>
	readonly domains: Readonly<Record<string, PlannedReachKey>>
}

/**
 * A literal in place of `value` that prints as a constant of the same type: PostgreSQL's parse of a printed literal
 * depends on its value only through its sign and, for an integer, whether int4, int8 or numeric holds it (scan.l,
 * parse_node.c make_const), so every literal of one class is one jumble.
 */
const canonicalLiteral = (value: LiteralValue): LiteralValue => {
	switch (value.kind) {
		case "int": {
			const negative = value.value < 0n
			const magnitude = negative ? -value.value : value.value
			const held = magnitude < 2n ** 31n ? 1n : magnitude < 2n ** 63n ? 2n ** 31n : 2n ** 63n
			return { kind: "int", value: negative ? -held : held }
		}
		case "decimal":
			return { kind: "decimal", value: value.value.startsWith("-") ? "-1" : "1" }
		case "text":
			return { kind: "text", value: "" }
		case "bits":
			return { kind: "bits", hex: "" }
		case "bool":
		case "float":
		case "floatSpecial":
		case "null":
			return value
	}
}

/** What a piece of a body reads of its function's frame: a variable, and a row of its trigger's relation. */
interface FrameReads {
	variable: boolean
	row: boolean
}

/** The relation a source reads by its alias alone, which is all PostgreSQL jumbles of it (`canonicalPiece`). */
const unnamed: ObjectName = { schema: "", name: "" }

/**
 * A piece of a body with every literal canonical (`canonicalLiteral`), every relation it reads by its alias alone where
 * that is all its jumble holds of it (`unnamed`), and what it reads of its frame, over every expression and FROM source
 * the Transform meets, a sub-query's included. PostgreSQL jumbles a relation by its alias (parsenodes.h RangeTblEntry
 * `eref`) and each column of it by its attribute number (primnodes.h Var `varattno`, its type ignored): so a relation of
 * which the piece reads no column is its alias alone. A relation read under an alias the piece gives two relations, or
 * with a column of no alias anywhere in the piece, keeps its name. `piece` reads whether a DELETE's own alias is named,
 * to unname its target.
 */
const canonicalPiece = <A>(
	piece: (t: Transform, named: (alias: string) => boolean) => A
): { readonly value: A; readonly reads: FrameReads } => {
	const columns = new Map<string, Set<string>>()
	const tables = new Map<string, Set<string>>()
	let unqualified = false
	const collect = (map: Map<string, Set<string>>, key: string, value: string): void => {
		const known = map.get(key)
		if (known === undefined) {
			map.set(key, new Set([value]))
		} else {
			known.add(value)
		}
	}
	piece(
		new Transform({
			...identityHooks,
			expr: (e) => {
				if (e.kind === "column") {
					if (e.table === undefined) {
						unqualified = true
					} else {
						collect(columns, e.table, e.column)
					}
				}
				return e
			},
			fromSource: (source) => {
				if (source.kind === "table") {
					collect(tables, source.alias, printObjectName(source.table))
				}
				return source
			}
		}),
		() => true
	)
	/** Whether the piece names a column of `alias`, every alias where it names a column of none. */
	const isNamed = (alias: string): boolean => unqualified || columns.has(alias)
	const reads: FrameReads = { variable: false, row: false }
	const t = new Transform({
		...identityHooks,
		expr: (e) => {
			if (e.kind === "literal") {
				return { ...e, value: canonicalLiteral(e.value) }
			}
			reads.variable ||=
				e.kind === "plVar" || e.kind === "param" || e.kind === "plSpecial" || e.kind === "field"
			reads.row ||=
				(e.kind === "plSpecial" && (e.name === "NEW" || e.name === "OLD")) ||
				(e.kind === "field" && e.record.kind === "plSpecial")
			return e
		},
		fromSource: (source) => {
			reads.row ||= source.kind === "transition" && isNamed(source.alias)
			return source.kind === "table" && !isNamed(source.alias)
				? { ...source, table: unnamed }
				: source
		}
	})
	return { value: piece(t, isNamed), reads }
}

/** A data-modifying statement with its target unnamed where it is a DELETE no column of whose alias its piece names. */
const unnamedTarget = (
	s: Insert | Update | Delete | Merge,
	named: (alias: string) => boolean
): Insert | Update | Delete | Merge =>
	s.kind === "delete" && !named(s.alias) ? { ...s, table: unnamed } : s

/** A trigger event's kind as TG_OP spells it. */
const tgOp: { readonly [K in PlannedEventKind]: string } = {
	insert: "INSERT",
	update: "UPDATE",
	delete: "DELETE",
	truncate: "TRUNCATE"
}

/**
 * Whether an IF condition holds of a trigger fired by `event`: true or false where it compares TG_OP with a text
 * literal, none where the event does not decide it, a function no trigger fires among them.
 */
const decided = (condition: Expr, event: PlannedEventKind | undefined): boolean | undefined => {
	if (
		event === undefined ||
		condition.kind !== "binary" ||
		condition.op !== "=" ||
		condition.left.kind !== "plSpecial" ||
		condition.left.name !== "TG_OP" ||
		condition.right.kind !== "literal" ||
		condition.right.value.kind !== "text"
	) {
		return undefined
	}
	return condition.right.value.value === tgOp[event]
}

/** A body's or a constant's walk: the identities of the queries it plans and what they reach. */
interface Walked {
	readonly identities: ReadonlyArray<string>
	/** Each RAISE's options' identities, by RAISE (PlannedReach `raises`). */
	readonly raises: ReadonlyArray<ReadonlyArray<string>>
	readonly reach: Reach
}

/** One query's identity: its parts' canonical text's digest. */
const identityOf = (parts: ReadonlyArray<unknown>): string => sha256Hex(canonicalTextOf(parts))

/**
 * The walk of PL/pgSQL function `fn`'s printed body as a trigger fired by `event` on `table` runs it, or as a call runs
 * it where `event` is none (see the header).
 */
const walkBody = (
	fn: PlFunction,
	event: PlannedEventKind | undefined,
	table: string | undefined
): Walked => {
	const printed = printedFunction(fn)
	const frame = [
		printed.returns === "trigger",
		printed.params.map((p) => p.type),
		printed.body.declare.map((d) => [d.name, d.type])
	]
	const identities: Array<string> = []
	const raises: Array<ReadonlyArray<string>> = []
	const reach = new ReachOf()
	let cases = 0
	/** One query the body plans: its kind and its piece, canonical, under the frame it reads. */
	const identityAt = (
		kind: string,
		piece: (t: Transform, named: (alias: string) => boolean) => unknown,
		variable: boolean
	): string => {
		const { value, reads } = canonicalPiece(piece)
		return identityOf([
			"plpgsql",
			kind,
			...(variable || reads.variable ? [["frame", frame]] : []),
			...(reads.row && table !== undefined ? [["row", table]] : []),
			value
		])
	}
	/** One query the body plans, its piece's identity (`identityAt`), under the frame where the piece reads a variable. */
	const query = (
		kind: string,
		piece: (t: Transform, named: (alias: string) => boolean) => unknown
	): void => {
		identities.push(identityAt(kind, piece, false))
	}
	/**
	 * One query PL/pgSQL builds over a variable of its own, under the frame whatever its piece reads: an assignment's, to
	 * its target's type; FOUND's test; a CASE's test of its hidden operand.
	 */
	const ownQuery = (
		kind: string,
		piece: (t: Transform, named: (alias: string) => boolean) => unknown
	): void => {
		identities.push(identityAt(kind, piece, true))
	}
	const statements = (list: ReadonlyArray<PlStatement>): void => {
		for (const s of list) {
			statement(s)
		}
	}
	const statement = (s: PlStatement): void => {
		switch (s.kind) {
			case "if": {
				for (const branch of s.branches) {
					query("expr", (t) => t.expr(branch.condition))
					reach.expr(branch.condition)
					const holds = decided(branch.condition, event)
					if (holds !== false) {
						statements(branch.body)
					}
					if (holds === true) {
						return
					}
				}
				return statements(s.else)
			}
			case "assign":
				ownQuery(`assign ${s.target}`, (t) => t.expr(s.value))
				reach.expr(s.value)
				return
			case "return":
				if (s.value.kind !== "plVar" && s.value.kind !== "plSpecial") {
					query("expr", (t) => t.expr(s.value))
					reach.expr(s.value)
				}
				return
			case "forQuery":
				query("select", (t) => t.setQuery(s.query))
				reach.setQuery(s.query)
				return statements(s.body)
			case "perform":
				query("perform", (t) => t.performQuery(s.query))
				reach.perform(s.query)
				return
			case "modify":
				query("dml", (t, named) => unnamedTarget(t.modified(s.statement), named))
				reach.dml(s.statement)
				return
			case "returnQuery":
				query("select", (t) => t.select(s.query))
				reach.query(s.query)
				return
			case "whenFound":
				query("found probe", (t) => t.select(s.query))
				reach.query(s.query)
				ownQuery("found", () => "FOUND")
				return statements(s.body)
			case "wholeReads":
				return statements(s.body)
			case "case": {
				const at = cases
				cases += 1
				query("expr", (t) => t.expr(s.operand))
				reach.expr(s.operand)
				for (const when of s.whens) {
					ownQuery(`case ${String(at)} when`, (t) => [
						t.expr(s.operand),
						when.values.map((v) => t.expr(v))
					])
					for (const v of when.values) {
						reach.expr(v)
					}
					statements(when.body)
				}
				return
			}
			case "raise": {
				const options: Array<string> = []
				for (const option of s.using) {
					options.push(identityAt("expr", (t) => t.expr(option.value), false))
					reach.expr(option.value)
				}
				raises.push(options)
				return
			}
			case "into": {
				const into = s.statement
				if (into.kind === "select") {
					query("select into", (t) => t.select(into))
					reach.query(into)
				} else {
					query("dml into", (t, named) => unnamedTarget(t.modified(into), named))
					reach.dml(into)
				}
				return
			}
		}
	}
	statements(printed.body.body)
	return { identities, raises, reach: reach.reach() }
}

/**
 * A PL/pgSQL constant's walk: the RETURN of its body, one query under its parameters (sql/ast.ts ConstantLanguage
 * `plpgsql`), none where its body is a parameter alone, and what it reaches; an SQL constant's, its body's reach alone.
 */
const walkConstant = (c: CreateConstant): Walked => {
	const reach = new ReachOf().expr(c.body).reach()
	if (c.language === "sql" || c.body.kind === "param") {
		return { identities: [], raises: [], reach }
	}
	const { value } = canonicalPiece((t) => t.expr(c.body))
	return {
		identities: [
			identityOf(["plpgsql", "expr", ["frame", [false, c.params.map((p) => p.type), []]], value])
		],
		raises: [],
		reach
	}
}

/** A table as the graph reads it: its columns, its CHECKs, and the foreign keys it holds. */
interface TableShape {
	readonly columns: Array<ColumnDef>
	readonly checks: Array<Expr>
	readonly references: Array<ForeignKey>
}

/** A trigger the installation or a stand-up creates, before its function's body is walked for its events. */
interface TriggerShape {
	/**
	 * Which of grizzle's triggers it is: a rule capture (sql/ast.ts CreateTransitionTrigger), an isolation guard
	 * (CreateGuardTrigger), an immutability guard (CreateImmutableGuardTrigger), all fired at the end of their statement;
	 * or a constraint trigger (CreateConstraintTrigger), the rule judge's arm's among them, deferred to COMMIT.
	 */
	readonly kind: "capture" | "guard" | "immutable" | "constraint"
	readonly table: string
	readonly events: ReadonlyArray<{
		readonly event: PlannedEventKind
		readonly columns: ReadonlyArray<string>
	}>
	readonly function: ObjectName
}

/** When a trigger of `kind` fires: at the end of its statement, or at COMMIT. */
const firesOf = (kind: TriggerShape["kind"]): PlannedTrigger["fires"] => {
	switch (kind) {
		case "capture":
		case "guard":
		case "immutable":
			return "immediate"
		case "constraint":
			return "deferred"
	}
}

/** A trigger walked, its identities not yet numbered. */
interface WalkedTrigger {
	readonly event: PlannedEventKind
	readonly columns: ReadonlyArray<string>
	readonly fires: PlannedTrigger["fires"]
	readonly walked: Walked
}

/** Every event a statement trigger on any write fires on: the isolation guard's (sql/ast.ts CreateGuardTrigger). */
const everyEvent: ReadonlyArray<{
	readonly event: PlannedEventKind
	readonly columns: ReadonlyArray<string>
}> = [
	{ event: "insert", columns: [] },
	{ event: "update", columns: [] },
	{ event: "delete", columns: [] },
	{ event: "truncate", columns: [] }
]

/**
 * The installation's tables, domains, views, policies, triggers and functions as the graph reads them off its
 * statements, each by its printed name: every statement kind named, so a new one is a decision here.
 */
class Indexed {
	readonly plFunctions = new Map<string, PlFunction>()
	readonly sqlFunctions = new Map<string, Reach>()
	readonly constants = new Map<string, Walked>()
	readonly declared = new Set<string>()
	readonly tables = new Map<string, TableShape>()
	readonly domains = new Map<string, CreateDomain>()
	/** What a role's read of each relation reaches beyond its rows: a view's query and a table's policies' filters. */
	readonly reads = new Map<string, ReachOf>()
	readonly triggers: Array<TriggerShape> = []

	shape(name: ObjectName): TableShape {
		const key = printObjectName(name)
		const known = this.tables.get(key)
		if (known !== undefined) {
			return known
		}
		const made: TableShape = { columns: [], checks: [], references: [] }
		this.tables.set(key, made)
		return made
	}

	constraint(table: ObjectName, c: TableConstraint): void {
		switch (c.kind) {
			case "check":
				this.shape(table).checks.push(c.predicate)
				return
			case "foreignKey":
				this.shape(table).references.push(c)
				return
			case "primaryKey":
			case "unique":
			case "exclude":
				return
		}
	}

	/** What a role's read of `name` reaches (`reads`), gathered as the statements state it. */
	read(name: ObjectName): ReachOf {
		const key = printObjectName(name)
		const known = this.reads.get(key)
		if (known !== undefined) {
			return known
		}
		const made = new ReachOf()
		this.reads.set(key, made)
		return made
	}

	statement(s: SqlStatement): void {
		switch (s.kind) {
			case "createFunction":
				if (s.language === "plpgsql") {
					this.plFunctions.set(printObjectName(s.name), s)
				} else {
					this.sqlFunctions.set(printObjectName(s.name), new ReachOf().expr(s.body).reach())
				}
				return
			case "createConstant":
				this.constants.set(printObjectName(s.name), walkConstant(s))
				return
			case "replaceConstant":
				this.constants.set(printObjectName(s.constant.name), walkConstant(s.constant))
				return
			case "createDeclaredFunction":
				this.declared.add(printObjectName(s.name))
				return
			case "createTable": {
				const shape = this.shape(s.table)
				for (const column of s.columns) {
					shape.columns.push(column)
				}
				for (const c of tableConstraints(s)) {
					this.constraint(s.table, c)
				}
				return
			}
			case "alterTable":
				for (const a of s.actions) {
					const column = addedColumn(a)
					if (column !== undefined) {
						this.shape(s.table).columns.push(column)
					}
					if (a.kind === "addConstraint") {
						this.constraint(s.table, a.constraint)
					}
				}
				return
			case "createStoredTable":
				this.shape(s.name)
				return
			case "createJudgeLog":
				this.shape(s.table)
				return
			case "createDomain":
				this.domains.set(printObjectName(s.name), s)
				return
			case "createView":
				this.read(s.name).setQuery(s.query)
				return
			case "createPolicy":
				this.read(s.table).expr(s.filter)
				return
			case "createTransitionTrigger":
				this.triggers.push({
					kind: "capture",
					table: printObjectName(s.table),
					events: [{ event: s.event, columns: [] }],
					function: s.function
				})
				return
			case "createConstraintTrigger":
				this.triggers.push({
					kind: "constraint",
					table: printObjectName(s.table),
					events: s.events.map((e) =>
						e.kind === "update"
							? { event: "update", columns: e.columns }
							: { event: e.kind, columns: [] }
					),
					function: s.function
				})
				return
			case "createGuardTrigger":
				this.triggers.push({
					kind: "guard",
					table: printObjectName(s.table),
					events: everyEvent,
					function: s.function
				})
				return
			case "createImmutableGuardTrigger":
				this.triggers.push({
					kind: "immutable",
					table: printObjectName(s.table),
					events:
						s.on === "rows"
							? [
									{ event: "update", columns: [] },
									{ event: "delete", columns: [] }
								]
							: [{ event: "truncate", columns: [] }],
					function: s.function
				})
				return
			case "select":
			case "insert":
			case "update":
			case "delete":
			case "merge":
			case "createSchema":
			case "rename":
			case "renameColumn":
			case "renameConstraint":
			case "alterDomain":
			case "createIndex":
			case "dropIndex":
			case "dropPolicy":
			case "drop":
			case "dropFunction":
			case "dropTrigger":
			case "handOverFunction":
			case "createRowType":
			case "alterRowType":
			case "adoptRole":
			case "endHolders":
			case "packConstant":
			case "stubConstant":
			case "createPublication":
			case "dropPublication":
			case "createLiveSecret":
			case "guardBracket":
			case "createRole":
			case "alterRole":
			case "grantRole":
			case "revokeRole":
			case "grant":
			case "revoke":
			case "grantColumns":
			case "alterDefaultPrivileges":
			case "createExtension":
			case "lockTable":
			case "comment":
			case "beginRead":
			case "beginWrite":
			case "commit":
			case "rollback":
			case "setConstraintsImmediate":
			case "fillStored":
				return
		}
	}
}

/** The columns of a table whose assignment can change one of `columns`: each, and every column a generated one reads. */
const assignedThrough = (
	shape: TableShape | undefined,
	columns: ReadonlyArray<string>
): ReadonlyArray<string> => {
	const out = new Set(columns)
	for (const c of shape?.columns ?? []) {
		if (columns.includes(c.name)) {
			for (const read of generationColumns(c.generated)) {
				out.add(read)
			}
		}
	}
	return [...out].toSorted(compareStrings)
}

/**
 * The referential actions PostgreSQL fires for foreign key `fk` of the table `child`, each on the table it fires on
 * (see the header): the check of a written referencing row, a PERIOD key's alone, and the NO ACTION check or the ON
 * UPDATE CASCADE of a removed or re-keyed referenced row, each with its queries' identities.
 */
const referenceTriggers = (
	child: string,
	childShape: TableShape,
	fk: ForeignKey,
	parentShape: TableShape | undefined
): ReadonlyArray<{ readonly table: string; readonly trigger: WalkedTrigger }> => {
	const parent = printObjectName(fk.references)
	const fkColumns = fk.columns.map((c) => c.column)
	const pkColumns = fk.referencedColumns.map((c) => c.column)
	const sides = [child, fkColumns, parent, pkColumns]
	const temporal = fk.columns.some((c) => c.period)
	const fires = fk.deferrable === "INITIALLY DEFERRED" ? "deferred" : "immediate"
	const plain = (identities: ReadonlyArray<string>, writes: Reach["writes"]): Walked => ({
		identities,
		raises: [],
		reach: { calls: new Set(), relations: new Set(), types: new Set(), writes }
	})
	const check = plain(temporal ? [identityOf(["ri", "check", ...sides])] : [], [])
	const noAction = plain(
		temporal
			? [identityOf(["ri", "noAction period", ...sides])]
			: [
					identityOf(["ri", "pk match", parent, pkColumns]),
					identityOf(["ri", "noAction", ...sides])
				],
		[]
	)
	const [first, ...rest] = fkColumns
	const cascade =
		first === undefined
			? noAction
			: plain(
					[identityOf(["ri", "cascade", ...sides])],
					[{ relation: child, event: { kind: "update", columns: [first, ...rest] } }]
				)
	return [
		{ table: child, trigger: { event: "insert", columns: [], fires, walked: check } },
		{
			table: child,
			trigger: {
				event: "update",
				columns: assignedThrough(childShape, fkColumns),
				fires,
				walked: check
			}
		},
		{ table: parent, trigger: { event: "delete", columns: [], fires, walked: noAction } },
		{
			table: parent,
			trigger:
				fk.onUpdate === "CASCADE"
					? {
							event: "update",
							columns: assignedThrough(parentShape, pkColumns),
							fires: "immediate",
							walked: cascade
						}
					: {
							event: "update",
							columns: assignedThrough(parentShape, pkColumns),
							fires,
							walked: noAction
						}
		}
	]
}

/** The planned graph of an installation's statements (see the header). */
export const plannedGraph = (statements: ReadonlyArray<SqlStatement>): PlannedGraph => {
	const indexed = new Indexed()
	for (const s of statements) {
		indexed.statement(s)
	}
	const functions = new Map<
		string,
		{ readonly kind: "definer" | "invoker"; readonly walked: Walked }
	>()
	for (const [name, fn] of indexed.plFunctions) {
		if (fn.returns !== "trigger") {
			functions.set(name, {
				kind: "definer",
				walked: walkBody(fn, undefined, undefined)
			})
		}
	}
	for (const [name, reach] of indexed.sqlFunctions) {
		functions.set(name, { kind: "definer", walked: { identities: [], raises: [], reach } })
	}
	for (const [name, walked] of indexed.constants) {
		functions.set(name, { kind: "invoker", walked })
	}
	const triggers = new Map<string, Array<WalkedTrigger>>()
	const attach = (table: string, trigger: WalkedTrigger): void => {
		const list = triggers.get(table)
		if (list === undefined) {
			triggers.set(table, [trigger])
		} else {
			list.push(trigger)
		}
	}
	const walkedTrigger = (shape: TriggerShape): void => {
		const fn = indexed.plFunctions.get(printObjectName(shape.function))
		if (fn === undefined) {
			return
		}
		for (const { event, columns } of shape.events) {
			attach(shape.table, {
				event,
				columns: assignedThrough(indexed.tables.get(shape.table), columns),
				fires: firesOf(shape.kind),
				walked: walkBody(fn, event, shape.table)
			})
		}
	}
	for (const shape of indexed.triggers) {
		walkedTrigger(shape)
	}
	for (const [child, shape] of indexed.tables) {
		for (const fk of shape.references) {
			for (const { table, trigger } of referenceTriggers(
				child,
				shape,
				fk,
				indexed.tables.get(printObjectName(fk.references))
			)) {
				attach(table, trigger)
			}
		}
	}
	const rows = new Map<string, Reach>()
	for (const [name, shape] of indexed.tables) {
		const row = new ReachOf()
		for (const check of shape.checks) {
			row.expr(check)
		}
		for (const column of shape.columns) {
			row.type(column.type)
			switch (column.generated?.kind) {
				case "stored":
					row.expr(column.generated.expr)
					break
				case "partial":
					row.expr(column.generated.when).expr(column.generated.expr)
					break
				case undefined:
					break
			}
		}
		rows.set(name, row.reach())
	}
	const domainReach = new Map<string, Reach>()
	for (const [name, domain] of indexed.domains) {
		const r = new ReachOf().type(domain.base)
		for (const c of domain.constraints) {
			r.expr(c.predicate)
		}
		domainReach.set(name, r.reach())
	}
	const identities = (walked: Walked): ReadonlyArray<string> => [
		...walked.identities,
		...walked.raises.flat()
	]
	const numbered = numbering([
		...[...functions.values()].flatMap((f) => identities(f.walked)),
		...[...triggers.values()].flatMap((list) => list.flatMap((t) => identities(t.walked)))
	])
	const numbers = (list: ReadonlyArray<string>): ReadonlyArray<number> =>
		[...new Set(list.map(numbered))].toSorted((a, b) => a - b)
	const reaches = new Map<PlannedReachKey, PlannedReach>()
	const keys: Array<ContentKey> = []
	/** What `walked` reaches, stored once in the table of reaches, by its key, its key held in the census. */
	const planned = (walked: Walked): PlannedReachKey => {
		const reach: PlannedReach = {
			queries: numbers(walked.identities),
			raises: walked.raises.map(numbers),
			calls: [...walked.reach.calls].toSorted(compareStrings),
			reads: [...walked.reach.relations].toSorted(compareStrings),
			types: [...walked.reach.types].toSorted(compareStrings),
			writes: uniqueWrites(walked.reach.writes)
		}
		const canonical = canonicalTextOf(["planned-reach", reach])
		const key = reachKey(canonical)
		if (!reaches.has(key)) {
			reaches.set(key, reach)
		}
		keys.push({ key, canonical, display: `the planned reach ${canonical}` })
		return key
	}
	const reached = (reach: Reach | undefined): PlannedReachKey =>
		planned({ identities: [], raises: [], reach: reach ?? new ReachOf().reach() })
	const relationNames = new Set([
		...indexed.tables.keys(),
		...indexed.reads.keys(),
		...triggers.keys()
	])
	const functionsOf: Readonly<Record<string, PlannedFunction>> = Object.fromEntries(
		[
			...[...functions].map(([name, f]): readonly [string, PlannedFunction] => [
				name,
				{ kind: f.kind, reach: planned(f.walked) }
			]),
			...[...indexed.declared].map((name): readonly [string, PlannedFunction] => [
				name,
				{ kind: "declared" }
			])
		].toSorted(([a], [b]) => compareStrings(a, b))
	)
	const relationsOf: Readonly<Record<string, PlannedRelation>> = Object.fromEntries(
		[...relationNames].toSorted(compareStrings).map(
			(name) =>
				[
					name,
					{
						read: reached(indexed.reads.get(name)?.reach()),
						row: reached(rows.get(name)),
						triggers: (triggers.get(name) ?? []).map((t): PlannedTrigger => ({
							event: t.event,
							columns: t.columns,
							fires: t.fires,
							reach: planned(t.walked)
						}))
					}
				] as const
		)
	)
	const domainsOf: Readonly<Record<string, PlannedReachKey>> = Object.fromEntries(
		[...domainReach]
			.toSorted(([a], [b]) => compareStrings(a, b))
			.map(([name, r]) => [name, reached(r)] as const)
	)
	unwrap(contentCensus(keys))
	return {
		reaches: Object.fromEntries([...reaches].toSorted(([a], [b]) => compareStrings(a, b))),
		functions: functionsOf,
		relations: relationsOf,
		domains: domainsOf
	}
}

/** Every identity's number in the order of identities: the graph's numbering of the queries it names. */
const numbering = (identities: ReadonlyArray<string>): ((identity: string) => number) => {
	const order = new Map(
		[...new Set(identities)].toSorted(compareStrings).map((identity, at) => [identity, at] as const)
	)
	return (identity) => defined(order.get(identity), `the number of planned query ${identity}`)
}

/** Writes each once, in the order of their canonical text. */
const uniqueWrites = (writes: ReadonlyArray<PlannedWrite>): ReadonlyArray<PlannedWrite> =>
	[...new Map(writes.map((w) => [canonicalTextOf(w), w] as const))]
		.toSorted(([a], [b]) => compareStrings(a, b))
		.map(([, w]) => w)
