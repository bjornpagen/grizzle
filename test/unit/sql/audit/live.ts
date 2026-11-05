import {
	array,
	boolean,
	clone,
	element,
	filter,
	type Gen,
	int,
	map,
	weighted
} from "@grizzle/testing/gen"
import { Array as Arr } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { identity } from "#compiler/core/identity.ts"
import * as Result from "#compiler/core/result.ts"
import type { Action, Declarations, Draft } from "#compiler/deploy/diff/plan.ts"
import { noWorkload } from "#compiler/deploy/snapshot/build.ts"
import { type Codebook, firstCodebook } from "#compiler/ir/codes.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { conservativeInput, flight } from "#compiler/lower/conservative/types.ts"
import { lowerOptimized } from "#compiler/lower/optimize/pipeline.ts"
import { deliveredAsOptimized, type FusedStatement } from "#compiler/lower/shapes/index.ts"
import { executableQuery } from "#compiler/lower/template.ts"
import { completeInstallOptions } from "#compiler/physical/complete.ts"
import { compileInstallation, type Installation } from "#compiler/physical/install/compile.ts"
import { parseSchemaInput, schemaArtifacts, schemaCatalog } from "#compiler/program/schema.ts"
import { ownLogin, rostersOf } from "#compiler/schema/own.ts"
import type { Expr, Select, SqlStatement } from "#compiler/sql/ast.ts"
import { and, eq, lit, types } from "#compiler/sql/build.ts"
import { ledger } from "#test/pg/laws/alternatives/schemas.ts"
import {
	batches,
	reasons,
	rota,
	signals,
	staffing,
	tree
} from "#test/pg/laws/projections/schemas.ts"
import { succeeded } from "#test/support/assert.ts"
import * as payroll from "#test/support/fixtures/ir/payroll.ts"
import * as queue from "#test/support/fixtures/ir/queue.ts"
import * as work from "#test/support/fixtures/ir/work.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { noHoles, oneHole, selectGen, statementGen } from "#test/support/kernel/sqlgen.ts"
import {
	type DeploySubject,
	draftCodes,
	fromEmpty,
	fromSnapshot,
	generate,
	noDeclarations,
	type Previous
} from "#test/support/migrate/kit.ts"
import { largeStatements } from "#test/support/oracle/forms.ts"
import { defaultGenConfig, type QueryCase, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { genParamDecls } from "#test/support/oracle/gen/query.ts"
import { schemaCodes, schemaDesc } from "#test/support/oracle/gen/schema.ts"
import { oracleLogin } from "#test/support/oracle/install/real.ts"
import {
	closureRoot,
	existsOverTakeRoot,
	fanoutJoinRoot,
	groupRoot,
	keyedJoinRoot,
	projectGroupRoot,
	rootedCaseGen,
	taggedUnionRoot,
	untaggedUnionRoot,
	witnessRoot
} from "#test/support/oracle/mutants/cases.ts"
import { elementAt } from "#test/support/oracle/pick.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { owning } from "#test/support/policy.ts"
import {
	books1,
	books2,
	books2Declared,
	plainPlans,
	shopV1,
	shopV2,
	shopV3,
	shopV3Declared,
	shopV4
} from "#test/unit/deploy/schemas.ts"
import { sqlCatalog } from "#test/unit/sql/audit/catalog.ts"
import { uuidOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	Code,
	Counter,
	mutableCrewChangeSet,
	mutableCrewCompiled,
	shopCompiled,
	shopChangeSet,
	Hand,
	Item,
	Pair,
	relabel,
	Seat,
	Stock,
	shopCompile
} from "#test/unit/write/put/support.ts"

/**
 * The Live statements of the audit suite: what the statement and text audits must admit, and what their Wild
 * operators break.
 *
 * Six sources, each drawn per case:
 *
 * - generated: a statement of the kernel's SQL generator (sqlgen.ts statementGen), over a catalog whose names are
 *   words SQL reserves and spellings only quoting keeps names, or, for the text breaks, an ALTER TYPE ... ADD VALUE IF
 *   NOT EXISTS of a drawn label, the form a migration that adds a label drafts;
 * - planted: a query of the same generator with a double -0 planted in one of its cores, which the persisted forms
 *   once lost, and which the generator draws at one numeric site among many, too seldom to reach in a run;
 * - lowered: a query case of the oracle generators (test/support/oracle/gen, and the mutant roots that densify one
 *   construct each), lowered conservatively and optimized under a drawn template context, with the R20
 *   variants and the executable form of every statement, beside the installation of the case's schema;
 * - installed: the installation of a fixture schema: the dictionary's real DDL, PL/pgSQL law functions, triggers and
 *   grants, which seed the search with what grizzle ships;
 * - drafted: the statements a migration drafted along a fixture chain holds, read from its draft's typed plan: the
 *   dictionary's other half, a source of its own so a generator weights it apart from the installations;
 * - written: a write program over the shop fixture (test/unit/write/put/support.ts), one drawn action or none on each
 *   of its relations that cover the put targets and a described put of Stock on top or not, compiled: every statement
 *   of its optimized and its conservative artifact.
 *
 * Every statement comes beside a twin built apart from it: a second draw from the same decisions (gen.ts clone),
 * a second lowering of the twin case, a second installation, draft or write compilation. The twin is structurally equal and shares no
 * identity, so what the audit suite checks of it holds of the statement whatever object identity it was built with.
 *
 * A lowering of a generated case never refuses it: a refusal is a capability the differential suites would miss as
 * well.
 *
 * A Live statement beside a twin built apart from it (a second draw from the same decisions, a second lowering
 * of the twin case, a second installation or draft): equal structure, distinct identity.
 */
export interface Twinned {
	readonly statement: SqlStatement
	readonly twin: SqlStatement
}

/** What a Live draw reached: its source, and a lowering's context. */
export type LiveFeature =
	| "source generated"
	| "source planted"
	| "source lowered"
	| "source installed"
	| "source drafted"
	| "source written"
	| "a member deleted under a mutable owner"
	| `context ${TemplateContext}`

/**
 * One Live draw: where it came from, and its statements, each beside its twin. The features name the source and the
 * lowering's context, never a value.
 */
export interface Live {
	readonly label: string
	readonly statements: Arr.NonEmptyReadonlyArray<Twinned>
	readonly features: ReadonlyArray<LiveFeature>
	/** For a lowered case: each statement's AST beside the text the lowering emitted for it. */
	readonly emitted: ReadonlyArray<{ readonly ast: SqlStatement; readonly text: string }>
	/** For a lowered case: the lowering run again, on the case and on its twin, which must emit the same texts. */
	readonly again: () => ReadonlyArray<ReadonlyArray<string>>
}

const nothingAgain = (): ReadonlyArray<ReadonlyArray<string>> => []

/**
 * Each statement beside the one at its index among statements built apart: the boundary every compiled source's
 * statements cross into a Live draw. Lists of different lengths are a nondeterministic lowering, installer or drafter,
 * and an empty one a source that built nothing to audit: each thrown inside the property, a counterexample.
 */
const twinned = (
	a: ReadonlyArray<SqlStatement>,
	b: ReadonlyArray<SqlStatement>
): Arr.NonEmptyReadonlyArray<Twinned> => {
	if (a.length !== b.length) {
		throw new Error(`a twin built apart has ${b.length} statements, not ${a.length}`)
	}
	const [first, ...rest] = Arr.zipWith(a, b, (statement, twin): Twinned => ({ statement, twin }))
	if (first === undefined) {
		throw new Error("a Live source built no statement")
	}
	return [first, ...rest]
}

const generatedLive = (statement: SqlStatement, twin: SqlStatement): Live => ({
	label: "generated",
	statements: [{ statement, twin }],
	features: ["source generated"],
	emitted: [],
	again: nothingAgain
})

/** -0 = 0 holds of doubles (IEEE 754, and PostgreSQL's float8eq), so conjoined to a WHERE it keeps every row. */
const negativeZero: Expr = eq(lit.float(-0, types.double), lit.float(0, types.double))

/**
 * A generated query with negativeZero conjoined to the WHERE of its pick-th core: a query holds a core by construction.
 */
const plantedQuery = (query: Select, pick: number): SqlStatement => {
	const [first, ...rest] = oneHole(query, {
		...noHoles,
		core: (c) => [
			{ ...c, where: c.where === undefined ? negativeZero : and([c.where, negativeZero]) }
		]
	})
	if (first === undefined) {
		throw new Error("a generated query holds no core")
	}
	return pickFrom([first, ...rest], pick).statement
}

const plantedLive = ({ query, twin, pick }: Extract<LiveSketch, { kind: "planted" }>): Live => ({
	label: "a generated query with -0 planted",
	statements: [{ statement: plantedQuery(query, pick), twin: plantedQuery(twin, pick) }],
	features: ["source planted"],
	emitted: [],
	again: nothingAgain
})

const failure = (what: string, e: CompileError): Error =>
	new Error(`${what} refused a generated case: ${e.message}`)

/**
 * A schema's complete installation under `codes`, as `grizzle generate` drafts it: natives, closed laws and derived
 * relations, with the one full role a generated schema runs as in its login (oracleLogin), so its roles, views,
 * policies and grants are audited too.
 */
const installationOf = (desc: unknown, codes: Codebook): Installation => {
	const owned = owning(desc)
	const login = ownLogin(oracleLogin(owned.desc))
	if (!login.ok) {
		throw failure("the login", login.error)
	}
	const installed = compileInstallation(
		owned,
		completeInstallOptions(owned, owned.installation, [login.value], [], codes)
	)
	if (!installed.ok) {
		throw failure("the installer", installed.error)
	}
	return installed.value
}

/** A fresh installation's codes for a fixture schema: each roster's handles numbered by position. */
const freshCodes = (desc: unknown): Codebook => firstCodebook(rostersOf(owning(desc)))

const logicalQuery = (c: QueryCase): LogicalQuery => ({
	dag: c.query.dag,
	params: genParamDecls(c.query)
})

/**
 * The statements a case lowers to, each AST beside the text the lowering emitted for it ("" for an executable form).
 */
type Lowered = ReadonlyArray<{ readonly ast: SqlStatement; readonly text: string }>

/**
 * Every statement a case lowers to: conservative and optimized, the R20 variants, and the executable form of every
 * conservative and optimized statement.
 */
const lowered = (c: QueryCase, context: TemplateContext): Lowered => {
	const artifacts = Result.flatMap(parseSchemaInput(schemaDesc(c.schema)), (schema) =>
		schemaArtifacts(schema, {
			installation: identity.schema(parsedSchemaName("audit")),
			vectorSchema: undefined,
			codes: schemaCodes(c.schema)
		})
	)
	if (!artifacts.ok) {
		throw failure("the installer", artifacts.error)
	}
	const names = artifacts.value.names
	const query = logicalQuery(c)
	const conservative = lowerConservative(conservativeInput(query), {
		names,
		params: query.params,
		subject: { kind: "query" }
	})
	if (!conservative.ok) {
		throw failure("the conservative lowering", conservative.error)
	}
	const out: Array<{ readonly ast: SqlStatement; readonly text: string }> = []
	const statement = (s: FusedStatement) => {
		out.push({ ast: s.ast, text: s.sql.text })
		out.push({ ast: executableQuery(s), text: "" })
	}
	Arr.forEach(flight(deliveredAsOptimized(conservative.value).roots), statement)
	const optimized = lowerOptimized(query, {
		names,
		catalog: schemaCatalog(artifacts.value),
		subject: { kind: "query" },
		context
	})
	if (!optimized.ok) {
		throw failure("the optimized lowering", optimized.error)
	}
	const program = optimized.value
	Arr.forEach(flight(program.roots), statement)
	for (const large of largeStatements(flight(program.roots), (l) => l)) {
		out.push({ ast: large.ast, text: large.sql.text })
	}
	return out
}

const caseGen: Gen<QueryCase> = weighted([
	[4, queryCaseGen(defaultGenConfig)],
	...Arr.map(
		[
			keyedJoinRoot,
			fanoutJoinRoot,
			witnessRoot,
			groupRoot,
			projectGroupRoot,
			taggedUnionRoot,
			untaggedUnionRoot,
			existsOverTakeRoot,
			closureRoot(false)
		],
		(root) => [1, rootedCaseGen(root, defaultGenConfig)] as const
	)
])

const contexts: Arr.NonEmptyReadonlyArray<TemplateContext> = ["snapshot", "transaction"]

const texts = (l: Lowered) => Arr.map(l, (s) => s.text)

const loweredLive = ({ c, twin, context }: Extract<LiveSketch, { kind: "lowered" }>): Live => {
	const first = lowered(c, context)
	const second = lowered(twin, context)
	return {
		label: `lowered for the ${context} context`,
		statements: twinned(
			[
				...Arr.map(first, (s) => s.ast),
				...installationOf(schemaDesc(c.schema), schemaCodes(c.schema)).statements
			],
			[
				...Arr.map(second, (s) => s.ast),
				...installationOf(schemaDesc(twin.schema), schemaCodes(twin.schema)).statements
			]
		),
		features: ["source lowered", `context ${context}`],
		emitted: Arr.filter(first, (s) => s.text !== ""),
		again: () => [texts(first), texts(lowered(c, context)), texts(second)]
	}
}

/** The fixture schemas whose installations the dictionary holds, the law suites' among them. */
const fixtureSchemas: Arr.NonEmptyReadonlyArray<readonly [string, unknown]> = [
	["shop v1", shopV1],
	["shop v2", shopV2],
	["shop v3", shopV3],
	["shop v4", shopV4],
	["books 1", books1],
	["books 2", books2],
	["plans", plainPlans(2n)],
	["Work", work.WorkDesc],
	["Reports", work.ReportsDesc],
	["Payroll", payroll.PayrollDesc],
	["Queue", queue.Queue],
	...Arr.flatMap([false, true], (mutable): ReadonlyArray<readonly [string, unknown]> => [
		[`staffing, mutable ${mutable}`, staffing({ mutable })],
		[`rota, mutable ${mutable}`, rota({ mutable })],
		[`tree, mutable ${mutable}`, tree({ mutable })],
		[`ledger, mutable ${mutable}`, ledger({ mutable })],
		[`reasons, mutable ${mutable}`, reasons({ mutable })],
		[`signals, mutable ${mutable}`, signals({ mutable })]
	]),
	["batches", batches()]
]

/** One step of a chain: the schema drafted, and the renames and drops it declares against the step before it. */
type ChainStep = readonly [DeploySubject, Declarations]

/** The migration chains whose drafted statements the dictionary holds. */
const chains: ReadonlyArray<readonly [string, ReadonlyArray<ChainStep>]> = [
	[
		"shop",
		[
			[shopV1, noDeclarations],
			[shopV2, noDeclarations],
			[shopV3, shopV3Declared],
			[shopV4, noDeclarations]
		]
	],
	[
		"books",
		[
			[books1, noDeclarations],
			[books2, books2Declared]
		]
	]
]

/**
 * The statements an action holds: a statement action's own. Every other action is reviewer-facing template text the
 * drafter renders (a placeholder, a law's violation check, an ANALYZE, a drop the AST has no form for), which no
 * production audit reads.
 */
const actionStatements = (a: Action): ReadonlyArray<SqlStatement> => {
	switch (a.kind) {
		case "statement":
			return [a.statement]
		case "placeholderColumn":
		case "placeholderRetype":
		case "violation":
		case "analyze":
		case "dropStatistics":
			return []
	}
}

/**
 * The statements a drafted step holds: its action's, the statements a reviewer confirms, or the statement of a loss a
 * reviewer writes in.
 */
const draftStatements = (d: Draft): ReadonlyArray<SqlStatement> => {
	switch (d.kind) {
		case "confirm":
			return d.keep
		case "loss":
			return [d.statement]
		case "statement":
		case "placeholderColumn":
		case "placeholderRetype":
		case "violation":
		case "analyze":
		case "dropStatistics":
			return actionStatements(d)
	}
}

/** The statements of each migration drafted along a chain, read from its draft's typed plan: one list per migration. */
const draftedMigrations = (
	steps: ReadonlyArray<ChainStep>
): ReadonlyArray<ReadonlyArray<SqlStatement>> => {
	const out: Array<ReadonlyArray<SqlStatement>> = []
	let previous: Previous = fromEmpty
	for (const [i, [desc, declared]] of steps.entries()) {
		const codes = succeeded(
			draftCodes(desc, previous, declared),
			"the drafter drafts the step's codes"
		)
		const drafted = succeeded(
			generate({
				previous,
				installation: installationOf(desc, codes),
				workload: noWorkload,
				declared,
				name: `step_${i + 1}`,
				timestamp: `2026101200000${i}`
			}),
			"the drafter drafts the step"
		)
		out.push(Arr.flatMap(drafted.plan.steps, (s) => draftStatements(s.draft)))
		previous = fromSnapshot(drafted.snapshot)
	}
	return out
}

/** The dictionary of real output: the fixture schemas' installations, and the migrations drafted along the chains. */
interface Dictionary {
	readonly installed: Arr.NonEmptyReadonlyArray<Live>
	readonly drafted: Arr.NonEmptyReadonlyArray<Live>
}

const installedEntry = ([name, desc]: readonly [string, unknown]): Live => ({
	label: `the installation of ${name}`,
	statements: twinned(
		installationOf(desc, freshCodes(desc)).statements,
		installationOf(desc, freshCodes(desc)).statements
	),
	features: ["source installed"],
	emitted: [],
	again: nothingAgain
})

/**
 * One entry per migration drafted along a chain, each beside the same migration drafted apart, so a kind only a few
 * migrations hold (an ALTER TYPE ... ADD VALUE) is one of the few kinds its entry holds. A migration whose every drafted
 * step is reviewer-facing text holds no statement, and no entry.
 */
const draftedEntries = ([name, steps]: readonly [
	string,
	ReadonlyArray<ChainStep>
]): ReadonlyArray<Live> => {
	const migrations = draftedMigrations(steps)
	const twins = draftedMigrations(steps)
	if (migrations.length !== twins.length) {
		throw new Error(
			`a chain drafted apart has ${twins.length} migrations, not ${migrations.length}`
		)
	}
	const pairs = Arr.zip(migrations, twins)
	return Arr.flatMap(pairs, ([statements, twin], i): ReadonlyArray<Live> =>
		statements.length === 0
			? []
			: [
					{
						label: `the migration step_${i + 1} drafted along ${name}`,
						statements: twinned(statements, twin),
						features: ["source drafted"],
						emitted: [],
						again: nothingAgain
					}
				]
	)
}

/**
 * The dictionary of real output, built when the module loads, once per process: it draws nothing, so every run holds
 * the same entries. Chains that drafted no migration holding a statement are a drafter regression, refused when the
 * module loads rather than leaving the drafted source with nothing to draw.
 */
const realOutput: Dictionary = ((): Dictionary => {
	const [drafted, ...moreDrafted] = Arr.flatMap(chains, draftedEntries)
	if (drafted === undefined) {
		throw new Error("the fixture chains drafted no migration that holds a statement")
	}
	return {
		installed: Arr.map(fixtureSchemas, installedEntry),
		drafted: [drafted, ...moreDrafted]
	}
})()

/** What a written draw does to one relation of the shop fixture: nothing, or one action over its fact. */
const writeOps = ["none", "insert", "put", "delete"] as const
type WriteOp = (typeof writeOps)[number]

/** Whether the shop's Crew is mutable, so a Hand's delete may shrink a stored Crew's family. */
type CrewMutability = "immutable" | "mutable"

/**
 * The actions a written draw may take on a relation: every one, but a Hand's delete only under a mutable Crew, since
 * an immutable Crew's family is fixed from its insert and the compiler refuses the delete.
 */
const opsOf = (relation: unknown, crew: CrewMutability): Arr.NonEmptyReadonlyArray<WriteOp> =>
	relation === Hand && crew === "immutable" ? ["none", "insert", "put"] : writeOps

/**
 * The shop relations a written draw acts on, each with its fact: an immutable and a mutable relation, a candidate key,
 * a pure set, a serial key written explicitly (OVERRIDING SYSTEM VALUE), a residual law's member and a serial field
 * outside the key.
 */
const writeTargets: ReadonlyArray<readonly [unknown, ReadonlyArray<unknown>]> = [
	[Item, [{ id: uuidOf(1), label: "a", qty: 1n }]],
	[Stock, [{ id: uuidOf(2), label: "b", qty: 2n }]],
	[Code, [{ id: uuidOf(3), code: "c" }]],
	[Pair, [{ a: uuidOf(4), b: "d" }]],
	[Seat, [{ no: 5n, label: "e" }]],
	[Hand, [{ id: uuidOf(6), crew: uuidOf(7), label: "f" }]],
	[Counter, [{ name: "g", n: 8n, seq: 9 }]]
]

/**
 * A write program before it is compiled: whether its shop's Crew is mutable, the action on each write target, by
 * position, and whether a described put of Stock comes on top, which only the shop with an immutable Crew states, since
 * the described put's query is over that shop.
 */
interface WriteSketch {
	readonly crew: CrewMutability
	readonly ops: ReadonlyArray<WriteOp>
	readonly described: boolean
}

/** A write sketch that writes something: a sketch of no action and no described put is drawn again. */
const writeSketchGen: Gen<WriteSketch> = filter(
	(source): WriteSketch => {
		const crew = source.draw(element(["immutable", "mutable"] as const))
		return {
			crew,
			ops: Arr.map(writeTargets, ([relation]) => source.draw(element(opsOf(relation, crew)))),
			described: crew === "immutable" && source.draw(boolean)
		}
	},
	(w) => w.described || Arr.some(w.ops, (op) => op !== "none"),
	8
)

/** Whether a write sketch deletes the Hand: a member of Crew's family. */
const deletesHand = (w: WriteSketch): boolean =>
	Arr.some(Arr.zip(writeTargets, w.ops), ([[relation], op]) => relation === Hand && op === "delete")

/** The ChangeSet a write sketch states, built afresh on every call. */
const changeSetOf = (w: WriteSketch) => {
	let value = w.crew === "mutable" ? mutableCrewChangeSet() : shopChangeSet()
	for (const [i, [relation, facts]] of writeTargets.entries()) {
		const op = w.ops[i]
		if (op === "insert") {
			value = value.insert(relation, facts)
		} else if (op === "put") {
			value = value.put(relation, facts)
		} else if (op === "delete") {
			value = value.delete(relation, facts)
		}
	}
	return w.described ? value.put(Stock, relabel("a", "b")) : value
}

/** Every statement a write compilation places, its optimized artifact's and then its conservative artifact's. */
const writtenStatements = (w: WriteSketch) => {
	const compiled = w.crew === "mutable" ? mutableCrewCompiled : shopCompiled
	const { optimized, conservative } = compiled(changeSetOf(w), shopCompile).artifacts
	return [...optimized.statements, ...conservative.statements]
}

const writtenLive = (w: WriteSketch): Live => {
	const placed = writtenStatements(w)
	const statements = Arr.map(placed, (s) => s.ast)
	return {
		label: "written",
		statements: twinned(
			statements,
			Arr.map(writtenStatements(w), (s) => s.ast)
		),
		features: [
			"source written",
			...(w.crew === "mutable" && deletesHand(w)
				? (["a member deleted under a mutable owner"] as const)
				: [])
		],
		emitted: Arr.map(placed, (s) => ({ ast: s.ast, text: s.spec.sql })),
		again: () => [
			Arr.map(placed, (s) => s.spec.sql),
			Arr.map(writtenStatements(w), (s) => s.spec.sql)
		]
	}
}

/**
 * A Live draw before it is compiled: the property compiles it, so a refusal of the installer, a lowering, the drafter
 * or the write compiler is a counterexample, shrunk and reported like any other.
 */
export type LiveSketch =
	| { readonly kind: "generated"; readonly statement: SqlStatement; readonly twin: SqlStatement }
	| {
			readonly kind: "planted"
			readonly query: Select
			readonly twin: Select
			readonly pick: number
	  }
	| {
			readonly kind: "lowered"
			readonly c: QueryCase
			readonly twin: QueryCase
			readonly context: TemplateContext
	  }
	| { readonly kind: "installed"; readonly index: number }
	| { readonly kind: "drafted"; readonly index: number }
	| { readonly kind: "written"; readonly sketch: WriteSketch }

/**
 * The twins of a generator: the value drawn, and the same decisions drawn again into a value built apart from it.
 */
const twins = <A>(generator: Gen<A>): Gen<readonly [A, A]> =>
	map(clone(generator, 2), (drawn) => {
		const [first, second] = drawn
		if (first === undefined || second === undefined) {
			throw new Error(`a clone of two holds ${drawn.length} values`)
		}
		return [first, second] as const
	})

/** A generated statement and a lowered case are drawn twice from the same decisions (gen.ts clone): the twins. */
const generatedSketchGen: Gen<LiveSketch> = map(
	twins(statementGen(sqlCatalog)),
	([statement, twin]): LiveSketch => ({ kind: "generated", statement, twin })
)

const loweredSketchGen: Gen<LiveSketch> = (source) => {
	const [c, twin] = source.draw(twins(caseGen))
	return { kind: "lowered", c, twin, context: source.draw(element(contexts)) }
}

/** A fixture schema's installation in the dictionary of real output, by its index. */
const installedSketchGen: Gen<LiveSketch> = map(
	int(0, realOutput.installed.length - 1),
	(index): LiveSketch => ({ kind: "installed", index })
)

/** A migration drafted along a fixture chain in the dictionary of real output, by its index. */
const draftedSketchGen: Gen<LiveSketch> = map(
	int(0, realOutput.drafted.length - 1),
	(index): LiveSketch => ({ kind: "drafted", index })
)

/** A generated query with -0 planted in one of its cores, picked: the cores are known only once the query is drawn. */
const plantedSketchGen: Gen<LiveSketch> = (source) => {
	const [query, twin] = source.draw(twins(selectGen(sqlCatalog)))
	return { kind: "planted", query, twin, pick: source.draw(pickGen) }
}

/**
 * A Live draw: a generated statement first, so a failure shrinks toward one; then a lowered case, an installation, a
 * drafted migration and a planted query, each a source of its own, so the rarer forms each holds are drawn at its own
 * weight rather than diluted among the others.
 */
export const liveSketchGen: Gen<LiveSketch> = weighted([
	[6, generatedSketchGen],
	[4, loweredSketchGen],
	[2, installedSketchGen],
	[1, draftedSketchGen],
	[1, plantedSketchGen]
])

/** A written draw: a generated write program over the shop fixture. */
export const writtenSketchGen: Gen<LiveSketch> = map(writeSketchGen, (sketch): LiveSketch => ({
	kind: "written",
	sketch
}))

/**
 * A Live draw for the break suites: real output carries the DDL, PL/pgSQL and drafted forms a generated statement
 * never holds, so its installations and drafted migrations are drawn as often as the generated and lowered sources
 * together.
 */
export const breakSketchGen: Gen<LiveSketch> = weighted([
	[2, generatedSketchGen],
	[1, loweredSketchGen],
	[2, installedSketchGen],
	[1, draftedSketchGen]
])

/** The Live statements of a draw. */
export const resolveLive = (sketch: LiveSketch): Live => {
	switch (sketch.kind) {
		case "generated":
			return generatedLive(sketch.statement, sketch.twin)
		case "planted":
			return plantedLive(sketch)
		case "lowered":
			return loweredLive(sketch)
		case "installed":
			return elementAt(
				realOutput.installed,
				sketch.index,
				"an installation in the dictionary of real output"
			)
		case "drafted":
			return elementAt(
				realOutput.drafted,
				sketch.index,
				"a drafted migration in the dictionary of real output"
			)
		case "written":
			return writtenLive(sketch.sketch)
	}
}
