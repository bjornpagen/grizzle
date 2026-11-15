import { navigateMember } from "#compiler/analysis/theory/navigate.ts"
import {
	newProbes,
	oldProbes,
	type Probe,
	regionQuery,
	type TouchedField
} from "#compiler/analysis/theory/query.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { appendAll } from "#compiler/core/array.ts"
import { canonicalTextOf, Refusal } from "#compiler/core/canonical.ts"
import { unsupported } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import {
	appendNonEmpty,
	headNonEmpty,
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "#compiler/core/nonempty.ts"
import { compareStrings } from "#compiler/core/order.ts"
import * as Result from "#compiler/core/result.ts"
import { temporarySchema } from "#compiler/core/temporary.ts"
import { defaultOpclass, type LawField, type RelationInfo } from "#compiler/ir/law.ts"
import { baseTypeRef } from "#compiler/ir/physical.ts"
import type { IndexRequest, PhysicalReason } from "#compiler/ir/products.ts"
import type { DeltaSide } from "#compiler/ir/rel.ts"
import { evidenceCatalog } from "#compiler/laws/model/catalog.ts"
import type { RuleTable, RuleTrigger } from "#compiler/laws/model/model.ts"
import { queryEvidence } from "#compiler/logical/annotate.ts"
import type { DeltaRelation } from "#compiler/lower/conservative/types.ts"
import { lowerOptimized, optimizedInput } from "#compiler/lower/optimize/pipeline.ts"
import { extractAccess } from "#compiler/physical/access/extract.ts"
import type { InstallBuilder } from "#compiler/physical/ddl/context.ts"
import { unaliased } from "#compiler/physical/derived/definition.ts"
import { enforcement, type Node } from "#compiler/physical/obligations/graph.ts"
import type {
	ColumnDefinition,
	CreateTransitionTrigger,
	Expr,
	FromSource,
	Insert,
	ObjectName,
	OperandSelect,
	PlFunction,
	PlStatement,
	Revoke,
	TransitionEvent,
	TransitionTable
} from "#compiler/sql/ast.ts"
import { transitionTables } from "#compiler/sql/ast.ts"
import {
	and,
	call,
	col,
	cUtf8Collation,
	eq,
	exists,
	lit,
	not,
	notExists,
	objectName,
	provedSelect,
	simpleSelect,
	types
} from "#compiler/sql/build.ts"
import { printTableName } from "#compiler/sql/print.ts"

/** A compiled probe: the statement whose rows break the rule, its outputs unaliased, and its index requests. */
interface Compiled {
	readonly statement: OperandSelect
	readonly requests: ReadonlyArray<IndexRequest>
}

const touched = (f: LawField): TouchedField => ({ name: f.name, desc: f.desc })

/**
 * The statements a guarded block of the judge runs, each once, in the order its first probe compiled: a set keyed by
 * the statement's canonical text, so a probe that compiles to a statement the block holds adds nothing (the statements
 * one key holds are one text, so whichever it keeps prints the same). Two occurrences of the touched relation that hold
 * nothing of its row apart (two arms of a derived relation that read it alike) are two probes of one statement, which a
 * COMMIT would otherwise run twice. Each probe's index requests stay the table's whatever its statement, since a
 * probe's requests come from the probe as written (Probe `requested`).
 */
const probeStatements = (probes: ReadonlyArray<Compiled>): ReadonlyArray<OperandSelect> => [
	...new Map(probes.map((p) => [canonicalTextOf(p.statement), p.statement] as const)).values()
]

/** The SQLSTATE condition a rule's kind raises under. */
const conditionOf = (rule: RuleTrigger): string => {
	switch (rule.rule.kind) {
		case "contained":
			return "foreign_key_violation"
		case "key":
			return "unique_violation"
		case "check":
			return "check_violation"
	}
}

/** The column identifiers of `relation`'s fields named `fields`. */
const columnsOf = (relation: RelationInfo, fields: ReadonlyArray<string>): ReadonlyArray<string> =>
	fields.flatMap((name) => relation.fields.flatMap((f) => (f.name === name ? [f.column] : [])))

/**
 * A probe read over its region (analysis/theory/query.ts regionQuery), the rows the transaction wrote of `relation` at
 * `record`, checked as a region read (check/checker.ts QueryRead `region`) and lowered by the optimized pipeline under
 * the transaction's evidence, its Delta node read from the session's delta table `deltas` names (RegionLowering), with
 * the index requests of its access paths.
 *
 * What lowers is the probe navigated (analysis/theory/navigate.ts navigateMember): one chain of steps from its region,
 * each a lookup of one relation by the columns the steps before it bound, so no estimate PostgreSQL makes, with
 * statistics or none, turns it into a join of every relation the probe reads, and planning it costs a plan of each step.
 * Its index requests are those of the probe as written over its row's fields (Probe `requested`): navigation reads the
 * same columns by equality in an order of its own, and a B-tree index serves an equality on each of its leading columns
 * in any order, so the indexes the probe as written requests serve every step.
 */
const compileProbe = (
	b: InstallBuilder,
	catalog: ReturnType<typeof evidenceCatalog>,
	rule: RuleTrigger,
	relation: RelationInfo,
	probe: Probe,
	record: "NEW" | "OLD",
	deltas: (relation: string, side: DeltaSide) => DeltaRelation | undefined
): Compiled => {
	const label = `rule ${rule.law.named.display} on ${relation.name}`
	const written = checkQuery(b.checked, probe.requested, { read: "rows", label })
	if (!written.ok) {
		throw new Refusal(written.error)
	}
	const lowered = Result.flatMap(
		checkQuery(
			b.checked,
			navigateMember(regionQuery(probe, relation.name, record, rule.law.loc), relation.loc),
			{ read: "region", label }
		),
		(checked) =>
			Result.flatMap(optimizedInput(checked, queryEvidence), (annotated) =>
				lowerOptimized(annotated, {
					names: b.names,
					subject: { kind: "ruleRegion", deltas },
					context: "transaction",
					catalog
				})
			)
	)
	if (!lowered.ok) {
		throw new Refusal(lowered.error)
	}
	const program = lowered.value
	const parts = program.parts
	if (
		parts.kind !== "one" ||
		parts.delivered.role.kind !== "main" ||
		program.statement.forms.kind !== "one"
	) {
		throw new Refusal(
			unsupported(relation.loc, `${label}: a probe that lowers to one main statement`)
		)
	}
	const main = parts.delivered
	if (main.params.length > 0) {
		throw new Refusal(
			unsupported(relation.loc, `${label}: a probe over its region that reads a parameter`)
		)
	}
	const statement = main.ast
	const access = extractAccess([written.value.dag.roots[0]], { pageable: [] })
	return {
		statement: { ...statement, body: unaliased(statement.body) },
		requests: access.paths.flatMap((path): ReadonlyArray<IndexRequest> => {
			const target = b.model.relations.get(path.relation)?.relation
			if (target === undefined || path.method === "hnsw" || path.derived) {
				return []
			}
			const keys = path.keys.flatMap((k) =>
				target.fields.flatMap((f) =>
					f.name === k.field
						? [
								{
									column: { kind: "field" as const, field: f },
									dir: k.dir,
									opclass: defaultOpclass
								}
							]
						: []
				)
			)
			return isNonEmpty(keys)
				? [
						{
							relation: target.name,
							keys,
							method: path.method,
							role: "lawMaintenance",
							use: "rule probe",
							justification: { kind: "law", law: rule.law.id }
						}
					]
				: []
		})
	}
}

/** The two sides of a table's writes a probe reads: its rows as a statement leaves them, and as it found them. */
type Side = "news" | "olds"

/**
 * A session's delta of one side of a table (`addRules`): the name of its table of pg_temp and its columns, its
 * relation's heading in the canonical order a query reads it in, a Delta node's (check/checker.ts), each of its field's
 * base type, so no session's table depends on a domain a
 * migration alters or drops (PostgreSQL refuses ALTER DOMAIN ... ADD CONSTRAINT over another session's temporary table,
 * and DROP DOMAIN while one names it).
 */
interface SessionDelta {
	readonly name: string
	readonly columns: NonEmptyReadonlyArray<ColumnDefinition>
}

/**
 * One side of a table the judge holds: its delta, and the columns a statement's UPDATE of a row must change for the
 * row to stand in it, the key and every column a rule reads on that side (analysis/theory/query.ts Touches), none
 * where no rule's facts on that side read a column the UPDATE can change.
 */
interface JudgedSide {
	readonly side: Side
	readonly delta: SessionDelta
	readonly read: ReadonlyArray<string>
}

/** A table the judge holds: its relation, the rules over queries that read it in trigger-name order, and its sides. */
interface JudgedTable {
	readonly relation: RelationInfo
	readonly rules: NonEmptyReadonlyArray<{ readonly rule: RuleTrigger; readonly table: RuleTable }>
	readonly sides: NonEmptyReadonlyArray<JudgedSide>
}

/** The catalog table `name` of pg_catalog under `alias`. */
const catalogTable = (name: string, alias: string): FromSource => ({
	kind: "table",
	table: objectName("pg_catalog", name),
	alias
})

/** The table of pg_temp named `name`. */
const sessionTable = (name: string): ObjectName => objectName(temporarySchema, name)

/** `name`'s relation in the session's own temporary schema, or NULL where it holds none. */
const regclassOf = (name: string): Expr =>
	call("to_regclass", [lit.text(printTableName(sessionTable(name)), types.text)])

/** That the session's temporary schema holds a relation named `name`. */
const standing = (name: string): Expr =>
	exists(simpleSelect([], [catalogTable("pg_class", "r1")], eq(col("r1", "oid"), regclassOf(name))))

/**
 * That the session's relation named `name` is a temporary table the function's definer owns, CURRENT_USER inside a
 * SECURITY DEFINER function, and stands where each of `more` holds of it.
 */
const ours = (name: string, from: ReadonlyArray<FromSource>, more: ReadonlyArray<Expr>): Expr =>
	exists(
		simpleSelect(
			[],
			[catalogTable("pg_class", "r2"), ...from],
			and([
				eq(col("r2", "oid"), regclassOf(name)),
				eq(call("pg_get_userbyid", [col("r2", "relowner")]), {
					kind: "user",
					name: "CURRENT_USER"
				}),
				eq(col("r2", "relpersistence"), lit.text("t", types.text)),
				...more
			])
		)
	)

/**
 * The refusal of a session table some other role made under the judge's name: a login that creates one first could
 * empty it before COMMIT, so the judge never reads a table its definer did not create.
 */
const foreign = (name: string): PlStatement => ({
	kind: "raise",
	message: "a session table of the rule judge that the judge's definer does not own",
	using: [
		{ option: "ERRCODE", value: lit.text("insufficient_privilege", types.text) },
		{ option: "SCHEMA", value: lit.text(temporarySchema, types.text) },
		{ option: "TABLE", value: lit.text(name, types.text) }
	]
})

/** Creates the delta where the session holds none, and refuses one the definer does not own (`foreign`). */
const ensured = (delta: SessionDelta): PlStatement => ({
	kind: "if",
	branches: [
		{
			condition: not(standing(delta.name)),
			body: [{ kind: "createSessionTable", name: delta.name, columns: delta.columns }]
		},
		{ condition: not(ours(delta.name, [], [])), body: [foreign(delta.name)] }
	],
	else: []
})

/**
 * Creates the sentinel and its trigger, which runs `judge`, where the session holds none, and refuses one the definer
 * does not own or whose trigger runs no judge of this installation (`foreign`): a sentinel left without its trigger, by a
 * DROP ... CASCADE of the judge, would arm nothing.
 */
const armedSentinel = (sentinel: string, judge: ObjectName): PlStatement => ({
	kind: "if",
	branches: [
		{
			condition: not(standing(sentinel)),
			body: [
				{ kind: "createSessionTable", name: sentinel, columns: [] },
				{ kind: "createSessionTrigger", name: sentinel, table: sentinel, function: judge }
			]
		},
		{
			condition: not(
				ours(
					sentinel,
					[catalogTable("pg_trigger", "r3")],
					[
						eq(col("r3", "tgrelid"), col("r2", "oid")),
						eq(
							col("r3", "tgfoid"),
							call("to_regprocedure", [lit.text(`${printTableName(judge)}()`, types.text)])
						)
					]
				)
			),
			body: [foreign(sentinel)]
		}
	],
	else: []
})

/** INSERT INTO pg_temp.<sentinel> SELECT WHERE NOT EXISTS (SELECT FROM pg_temp.<sentinel>): its one row, once. */
const arming = (sentinel: string): PlStatement => ({
	kind: "modify",
	statement: {
		kind: "insert",
		with: undefined,
		table: sessionTable(sentinel),
		alias: undefined,
		overriding: undefined,
		onConflict: undefined,
		returning: [],
		columns: [],
		source: {
			kind: "query",
			query: provedSelect(
				"oneRow",
				[],
				[],
				notExists(
					simpleSelect(
						[],
						[{ kind: "table", table: sessionTable(sentinel), alias: "r1" }],
						undefined
					)
				)
			)
		}
	}
})

/**
 * The rows of one side a statement wrote into its delta: every row of the transition table `rows`, or, for an UPDATE,
 * each row the other transition table holds no row of with the same key and the same value of every column the side
 * reads (`JudgedSide.read`), so an UPDATE of columns no rule reads there captures nothing. Every row stands once in a
 * transition table, and its key with it, so the rows are a set.
 */
const captured = (
	relation: RelationInfo,
	side: JudgedSide,
	rows: TransitionTable,
	other: TransitionTable | undefined
): PlStatement => {
	const columns = mapNonEmpty(side.delta.columns, (c) => c.name)
	const [first, ...rest] = mapNonEmpty(relation.primaryFields, (f): string => f.column)
	const compared: NonEmptyReadonlyArray<string> = [
		first,
		...rest,
		...side.read.filter((c) => c !== first && !rest.includes(c))
	]
	const unchanged =
		other === undefined
			? undefined
			: notExists(
					simpleSelect(
						[],
						[{ kind: "transition", table: other, alias: "r2" }],
						and(mapNonEmpty(compared, (c) => eq(col("r2", c), col("r1", c))))
					)
				)
	const insert: Insert = {
		kind: "insert",
		with: undefined,
		table: sessionTable(side.delta.name),
		alias: undefined,
		overriding: undefined,
		onConflict: undefined,
		returning: [],
		columns,
		source: {
			kind: "query",
			query: provedSelect(
				"keyed",
				columns.map((c) => ({ expr: col("r1", c), alias: undefined })),
				[{ kind: "transition", table: rows, alias: "r1" }],
				unchanged
			)
		}
	}
	return { kind: "modify", statement: insert }
}

/** A rule's RAISE, today's per-row one, naming the rule's table by literals: the judge fires on its sentinel. */
const raiseOf = (b: InstallBuilder, rule: RuleTrigger, relation: RelationInfo): PlStatement => {
	const installed = b.names.relation(relation.name)
	return {
		kind: "raise",
		message: "a write breaks a rule over a query",
		using: [
			{ option: "ERRCODE", value: lit.text(conditionOf(rule), types.text) },
			{ option: "CONSTRAINT", value: lit.text(identifierOf(rule.named), types.text) },
			{ option: "SCHEMA", value: lit.text(installed.schema, types.text) },
			{ option: "TABLE", value: lit.text(installed.name, types.text) }
		]
	}
}

/** The fields a side's rules read of the table on that side, by Touches. */
const sideFields = (
	touches: RuleTable["touches"],
	side: Side
): ReadonlyArray<string> | undefined => {
	switch (touches.kind) {
		case "news":
			return side === "news" ? touches.news : undefined
		case "olds":
			return side === "olds" ? touches.olds : undefined
		case "both":
			return side === "news" ? touches.news : touches.olds
	}
}

/** Each table a rule over a query reads, with its rules in trigger-name order and the sides they read of it. */
const judgedTables = (b: InstallBuilder): ReadonlyArray<JudgedTable> => {
	const ordered = b.model.rules.toSorted((x, y) =>
		compareStrings(identifierOf(x.named), identifierOf(y.named))
	)
	const byRelation = new Map<
		string,
		Array<{ readonly rule: RuleTrigger; readonly table: RuleTable }>
	>()
	for (const rule of ordered) {
		for (const t of rule.tables) {
			const held = byRelation.get(t.relation.name) ?? []
			held.push({ rule, table: t })
			byRelation.set(t.relation.name, held)
		}
	}
	return [...byRelation.values()].flatMap((held): ReadonlyArray<JudgedTable> => {
		const [head, ...more] = held
		if (head === undefined) {
			return []
		}
		const relation = head.table.relation
		const columns = mapNonEmpty(relation.heading, (f): ColumnDefinition => {
			const type = baseTypeRef(b.names, f.type)
			return {
				name: f.column,
				type,
				collation: type.kind === "builtin" && type.name === "text" ? cUtf8Collation : undefined
			}
		})
		const sides = (["news", "olds"] as const).flatMap((side): ReadonlyArray<JudgedSide> => {
			const read = held.flatMap(({ table: t }) => {
				const f = sideFields(t.touches, side)
				return f === undefined ? [] : [f]
			})
			return read.length === 0
				? []
				: [
						{
							side,
							delta: {
								name: b.name(
									identity.ruleDelta(
										headNonEmpty(b.names.levels),
										relation.name,
										side,
										canonicalTextOf(columns)
									)
								),
								columns
							},
							read: [...new Set(columnsOf(relation, read.flat()))]
						}
					]
		})
		const [s0, ...ss] = sides
		return s0 === undefined ? [] : [{ relation, rules: [head, ...more], sides: [s0, ...ss] }]
	})
}

/**
 * Rules over queries in the installation, held by the set judge: each table a rule over a query reads captures the rows
 * each statement writes of it, and one judge runs every rule's probes once over them, at COMMIT, on the state the
 * transaction leaves. A rule one of whose sides reads a derived relation is judged over the rows the transaction wrote:
 *
 * - of a table the rule's breaking side reads (a containment's source, a key's or a check's relation), the rows an
 *   INSERT or an UPDATE of a column it reads leaves, whose probes (analysis/theory/query.ts newProbes) read the side's
 *   facts each row derives at its primary key;
 * - of a table a containment's target reads, the rows a DELETE or such an UPDATE found, whose probes (oldProbes) read
 *   the target tuples each row may have withdrawn and the source tuples that needed them;
 * - of a table a side reads inside a negation, the other way round: inserted rows where a containment's target negates
 *   it, whose probes read the target tuples each now blocks, and deleted rows where the breaking side does, whose probes
 *   read the side's facts each no longer blocks.
 *
 * The parts:
 *
 * - Capture: on each table, an AFTER statement trigger per event its rules read (sql/ast.ts CreateTransitionTrigger):
 *   INSERT where a rule reads NEW, DELETE where one reads OLD, UPDATE where one reads a column on either side. Its
 *   function writes the rows the statement wrote into the session's delta of each side (`captured`): delta.added, the
 *   rows as the statement leaves them, delta.removed, as it found them, every column of the relation's heading, typed by
 *   its base type, an UPDATE's only where it changed the key or a column the side reads. Each delta is a table of
 *   pg_temp, created at the session's first capture of that side, ON COMMIT DELETE ROWS, so it lives as long as the
 *   session and holds one transaction's rows. Its columns name no domain: a session's table typed by one would block
 *   DROP DOMAIN and ALTER DOMAIN ... ADD CONSTRAINT in every other session while it lives.
 * - Arming: the capture then inserts the one row of the session's sentinel, a table of pg_temp created with it, whose
 *   DEFERRABLE INITIALLY DEFERRED constraint trigger runs the judge, so the judge runs once, at COMMIT, or at SET
 *   CONSTRAINTS ALL IMMEDIATE and after each statement from then on. A sentinel that holds its row arms nothing more.
 * - The judge: it deletes the sentinel's row, so a later statement arms it again, and refuses a delta the definer does
 *   not own; then, for each rule in trigger-name order, each table it reads and each side it reads there, it runs each
 *   probe of that table and side over its region (`compileProbe`), the session's delta, and raises where one returns a
 *   row: SQLSTATE 23503 for a containment, 23505 for a key and 23514 for a check, naming the rule's trigger name as its
 *   constraint and the rule's table, with no DETAIL, since the writer may not see the rows. The deltas keep their rows
 *   until COMMIT deletes them: a probe that reads a row again after SET CONSTRAINTS ALL IMMEDIATE judges it on the state
 *   as it stands, which is sound.
 * - Tamper: pg_temp is one namespace per session, which every role of it writes, so a login could create a delta or the
 *   sentinel first, own it and empty it before COMMIT. Every capture checks the sentinel and the delta it writes, and
 *   the judge every delta it reads: each must be the definer's own temporary table (`ours`), the sentinel's trigger the
 *   judge, or the statement is refused, insufficient_privilege naming the table (`foreign`). Every function is SECURITY
 *   DEFINER under closedSearchPath, every name it reads schema-qualified, EXECUTE revoked from PUBLIC.
 *
 * Every writer of a guarded table is SERIALIZABLE (isolation.ts), so PostgreSQL's SSI orders each probe's reads against
 * a concurrent write there. A READ COMMITTED role writes a table the rule reads only where certification proves the
 * rule monotone in its writes (analysis/isolation/certify.ts `laws`): its probes read at COMMIT, at a snapshot of their
 * own, and a write they miss can only withdraw a violation, never add one.
 *
 * The judge lives as long as the installation: every installation holds it, one name (identity.ruleJudge), its rules
 * none or many, and a migration replaces it in place and never drops it, since every session's sentinel's trigger names
 * it and PostgreSQL refuses to drop a function a trigger of another session runs. A migration that adds an
 * installation's first rule over a query or removes its last one changes only the judge's body and the captures. Each probe's access paths
 * (physical/access/extract.ts) are law-maintenance index requests of the rule, so a probe reads by index wherever the
 * planner can, and its cost follows the write.
 */
export const addRules = (b: InstallBuilder): ReadonlyArray<IndexRequest> => {
	const catalog = evidenceCatalog({ laws: b.model, views: [] })
	const tables = judgedTables(b)
	const judge = objectName(b.schema, b.name(identity.ruleJudge()))
	const sentinel = b.name(identity.ruleSentinel(headNonEmpty(b.names.levels)))
	const deltaOf = (t: JudgedTable, side: Side): SessionDelta | undefined =>
		t.sides.find((s) => s.side === side)?.delta
	const requests: Array<IndexRequest> = []
	const judged = tables.flatMap((t) =>
		t.rules.map(({ rule, table: rt }) => {
			const relation = t.relation
			const key = mapNonEmpty(relation.primaryFields, touched)
			const fields = relation.fields.map(touched)
			const deltas = (name: string, side: DeltaSide): DeltaRelation | undefined => {
				const delta =
					name !== relation.name
						? undefined
						: side === "added"
							? deltaOf(t, "news")
							: side === "removed"
								? deltaOf(t, "olds")
								: undefined
				return delta === undefined
					? undefined
					: {
							kind: "session",
							table: sessionTable(delta.name),
							columns: delta.columns.map((c) => c.name)
						}
			}
			const compile =
				(record: "NEW" | "OLD") =>
				(probe: Probe): Compiled =>
					compileProbe(b, catalog, rule, relation, probe, record, deltas)
			const raise = raiseOf(b, rule, relation)
			const sideProbes = (
				side: Side,
				probes: ReadonlyArray<Compiled>
			): ReadonlyArray<PlStatement> => {
				const delta = deltaOf(t, side)
				appendAll(
					requests,
					probes.flatMap((p) => p.requests)
				)
				const statements = probeStatements(probes)
				return delta === undefined || statements.length === 0
					? []
					: [
							{
								kind: "if",
								branches: [
									{
										condition: standing(delta.name),
										body: statements.map((statement): PlStatement => ({
											kind: "if",
											branches: [{ condition: exists(statement), body: [raise] }],
											else: []
										}))
									}
								],
								else: []
							}
						]
			}
			return {
				order: identifierOf(rule.named),
				body: [
					...(rt.touches.kind === "olds"
						? []
						: sideProbes(
								"news",
								newProbes(rule.rule, relation.name, key, fields, rule.law.loc).map(compile("NEW"))
							)),
					...(rt.touches.kind === "news"
						? []
						: sideProbes(
								"olds",
								oldProbes(rule.rule, relation.name, fields, rule.law.loc).map(compile("OLD"))
							))
				]
			}
		})
	)
	const deltas = tables.flatMap((t) => t.sides.map((s) => s.delta.name)).toSorted(compareStrings)
	const reasons: ReadonlyArray<PhysicalReason> = [
		enforcement(`the rules over queries of schema ${b.owned.name}`),
		...b.model.rules.map((rule) => ({ kind: "law" as const, law: rule.law.id }))
	]
	const judgeDdl: readonly [PlFunction, Revoke] = [
		{
			kind: "createFunction",
			language: "plpgsql",
			name: judge,
			params: [],
			returns: "trigger",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			body: {
				declare: [],
				body: appendNonEmpty(
					[
						{
							kind: "modify",
							statement: {
								kind: "delete",
								with: undefined,
								table: sessionTable(sentinel),
								alias: "r1",
								using: [],
								where: undefined,
								returning: []
							}
						},
						...deltas.map((name): PlStatement => ({
							kind: "if",
							branches: [
								{ condition: and([standing(name), not(ours(name, [], []))]), body: [foreign(name)] }
							],
							else: []
						})),
						...judged.toSorted((x, y) => compareStrings(x.order, y.order)).flatMap((j) => j.body)
					],
					{ kind: "return", value: { kind: "plSpecial", name: "NEW" } }
				)
			}
		},
		revokeOf(judge)
	]
	const reads = [...new Set(b.model.rules.flatMap((rule) => rule.law.reads))].flatMap((name) =>
		b.model.relations.has(name) ? [b.table(name)] : []
	)
	const judgeNode = b.add(
		{
			kind: "ruleJudge",
			ident: b.qualified("function", identity.ruleJudge()),
			ddl: judgeDdl,
			reasons,
			phase: "validate"
		},
		reads
	)
	const events = new Set<TransitionEvent>()
	for (const t of tables) {
		addCapture(b, t, judge, sentinel, judgeNode, events)
	}
	for (const event of events) {
		b.name(identity.captureTrigger(event))
	}
	return requests
}

/** REVOKE EXECUTE ON FUNCTION <fn>() FROM PUBLIC. */
const revokeOf = (fn: ObjectName): Revoke => ({
	kind: "revoke",
	privileges: ["EXECUTE"],
	on: { kind: "FUNCTION", names: [{ ...fn, args: [] }] },
	from: [{ kind: "PUBLIC" }]
})

/**
 * A table's capture (`addRules`): its function, which checks the sentinel, writes the statement's rows into the delta of
 * each side its event reads and arms the sentinel, and its transition triggers, one per event, each recorded in
 * `events`.
 */
const addCapture = (
	b: InstallBuilder,
	t: JudgedTable,
	judge: ObjectName,
	sentinel: string,
	judgeNode: Node<"validate">,
	events: Set<TransitionEvent>
): void => {
	const relation = t.relation
	const named = identity.ruleCapture(relation.name)
	const fn = objectName(b.schema, b.name(named))
	const side = (s: Side): JudgedSide | undefined => t.sides.find((x) => x.side === s)
	const news = side("news")
	const olds = side("olds")
	const writes = (
		s: JudgedSide,
		rows: TransitionTable,
		other: TransitionTable | undefined
	): ReadonlyArray<PlStatement> => [ensured(s.delta), captured(relation, s, rows, other)]
	const updated = [news, olds].flatMap((s): ReadonlyArray<PlStatement> =>
		s === undefined || s.read.length === 0
			? []
			: s.side === "news"
				? writes(s, transitionTables.news, transitionTables.olds)
				: writes(s, transitionTables.olds, transitionTables.news)
	)
	const branches = [
		...(news === undefined
			? []
			: [{ event: "insert" as const, body: writes(news, transitionTables.news, undefined) }]),
		...(updated.length === 0 ? [] : [{ event: "update" as const, body: updated }]),
		...(olds === undefined
			? []
			: [{ event: "delete" as const, body: writes(olds, transitionTables.olds, undefined) }])
	]
	const [b0, ...bs] = branches
	if (b0 === undefined) {
		return
	}
	const reasons = t.rules.map(({ rule }) => ({ kind: "law" as const, law: rule.law.id }))
	const ddl: readonly [PlFunction, Revoke] = [
		{
			kind: "createFunction",
			language: "plpgsql",
			name: fn,
			params: [],
			returns: "trigger",
			volatility: "VOLATILE",
			parallel: "UNSAFE",
			security: "DEFINER",
			body: {
				declare: [],
				body: [
					armedSentinel(sentinel, judge),
					{
						kind: "if",
						branches: mapNonEmpty([b0, ...bs], (x) => ({
							condition: eq(
								{ kind: "plSpecial", name: "TG_OP" },
								lit.text(x.event.toUpperCase(), types.text)
							),
							body: x.body
						})),
						else: []
					},
					arming(sentinel),
					{ kind: "return", value: { kind: "plSpecial", name: "NEW" } }
				]
			}
		},
		revokeOf(fn)
	]
	const fnNode = b.add(
		{ kind: "lawFunction", ident: b.qualified("function", named), ddl, reasons, phase: "validate" },
		[judgeNode, b.table(relation.name)]
	)
	for (const { event } of branches) {
		events.add(event)
		const trigger: CreateTransitionTrigger = {
			kind: "createTransitionTrigger",
			name: identifierOf(identity.captureTrigger(event)),
			table: b.names.relation(relation.name),
			event,
			function: fn
		}
		b.add(
			{
				kind: "lawTrigger",
				ident: {
					kind: "trigger",
					schema: b.names.levelOf(relation.name),
					relation: b.names.relationNamed(relation.name),
					name: identity.captureTrigger(event)
				},
				ddl: [trigger],
				reasons,
				phase: "validate"
			},
			[fnNode, b.table(relation.name)]
		)
	}
}
