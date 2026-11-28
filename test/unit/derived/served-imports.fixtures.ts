/**
 * The box of test/unit/derived/served-imports.test.ts: a lesson's content and a learner's visits, the shapes of
 * edullm's take, enter and finish (reads of the lesson's items, its statement led by `r33` and `r8`) and of its answer
 * and record (a write whose member reads them, led by `r18`): a served program that joins the learner's visit, bound by
 * its parameter, to a closed, parameter-free derivation over the content, its package's test roots, each root node of
 * kind 302 with its identifier attribute (name 86), which the program imports under an empty bind map, matched where
 * it stands or inside a query the program binds the visit's package to.
 *
 * Content sits in the unit Package, sealed at founding or not; the derivation keeps each root's path in its head, so
 * its upkeep re-derives one path's roots at a write, or drops it, so its upkeep would re-derive the whole package at
 * every write of it unless the package is sealed (analysis/derived/storage.ts deltaBounded).
 */

import * as Result from "@bjornpagen/grizzle-text/base/result"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { noClock, transactionClock } from "#compiler/ir/clock.ts"
import { firstCodebook } from "#compiler/ir/codes.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { decodeDesc, type ProgramDesc, type SchemaDesc } from "#compiler/ir/desc.ts"
import type { RelDag } from "#compiler/ir/rel.ts"
import { installBasis, unserved } from "#compiler/physical/install/plan.ts"
import { compileQuery, querySchema } from "#compiler/program/compile.ts"
import { parseSchemaInput, queryInput } from "#compiler/program/input.ts"
import { baseArtifacts, type SchemaArtifacts } from "#compiler/program/schema.ts"
import { Fn } from "#compiler/public/compute.ts"
import { int2, int4 } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import { fn, relation, row, rows, schema, sealed, unit } from "#compiler/public/schema.ts"
import { fullRoleDesc, ownLogin, rostersOf } from "#compiler/schema/own.ts"
import { servedImportsOf } from "#compiler/schema/reach.ts"
import { schemaDescOf } from "#compiler/schema/schema.ts"
import { changeSetOver as ChangeSet, changeSetDesc } from "#compiler/write/changeset/value.ts"
import { compileChangeSet } from "#compiler/write/frontend/compile.ts"

/**
 * The served program: a read of the lesson's roots (take, enter, finish), or a write whose member inserts the rows of a
 * declared function's call over them, its argument the roots (answer and record, response admission's call).
 */
export type Program = "read" | "call"
/** The derivation's head: each root's path and package kept, its path dropped, or its package dropped too. */
export type Head = "per path" | "per package" | "across packages"
/** Whether the content's unit is sealed at founding. */
export type Sealing = "sealed" | "open"
/** Where the program imports the derivation: matched where it stands, or inside a query it binds the package to. */
export type Placement = "matched" | "bound"

export interface ServedCase {
	readonly program: Program
	readonly head: Head
	readonly sealing: Sealing
	readonly placement: Placement
}

const programs = ["read", "call"] as const satisfies ReadonlyArray<Program>
const unitHeads = ["per path", "per package"] as const satisfies ReadonlyArray<Head>
const sealings = ["sealed", "open"] as const satisfies ReadonlyArray<Sealing>
const placements = ["matched", "bound"] as const satisfies ReadonlyArray<Placement>

/**
 * A case of the box: a derivation across packages imported where it stands alone, since a query bound to the visit's
 * package reads the package off its roots.
 */
export const servedCase: Gen<ServedCase> = (s) => {
	const program = s.draw(element(programs))
	const sealing = s.draw(element(sealings))
	return s.draw(boolean)
		? { program, head: "across packages", sealing, placement: "matched" }
		: {
				program,
				head: s.draw(element(unitHeads)),
				sealing,
				placement: s.draw(element(placements))
			}
}

/** The content relations the derivation reads, which a stored derivation's table stands in for. */
export const contentRelations = ["Attribute", "Node"] as const

const Node = relation(
	"Node",
	{
		package: int4,
		path: int4,
		start: int4,
		kind: int2,
		parentKind: int2
	},
	["package", "path", "start"]
)
const Attribute = relation(
	"Attribute",
	{
		package: int4,
		path: int4,
		start: int4,
		name: int2,
		value: int4
	},
	["package", "path", "start", "name"]
)
const Visit = relation("Visit", { child: int4, stage: int4, package: int4 }, ["child", "stage"])
const Seen = relation("Seen", { child: int4, stage: int4, identifier: int4 }, [
	"child",
	"stage",
	"identifier"
])

/** The rows a call admits: the identifiers it reads off its argument's roots. */
const admittedRows = row(rows({ admitted: rows({ identifier: int4 }) }))

/** Response admission's shape over the roots of one package, its argument their identifiers. */
const admitLesson = fn("admitLesson", {
	calls: [],
	args: { roots: rows({ identifier: int4 }) },
	returns: admittedRows,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT NULL`
})

/** Response admission's shape over the roots themselves, each with its package and its path. */
const admitPaths = fn("admitPaths", {
	calls: [],
	args: { roots: rows({ package: int4, path: int4, identifier: int4 }) },
	returns: admittedRows,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT NULL`
})

/** Response admission's shape over the roots themselves, each with its package. */
const admitPackages = fn("admitPackages", {
	calls: [],
	args: { roots: rows({ package: int4, identifier: int4 }) },
	returns: admittedRows,
	volatility: "immutable",
	nullInput: "called",
	language: "sql",
	body: fn.body`SELECT NULL`
})

/** The case's schema: the content in the unit Package, sealed or not, and the learner's visits and seen roots. */
const contentOf = (sealing: Sealing) =>
	schema(
		"ServedImports",
		[Node, Attribute, Visit, Seen, admitLesson, admitPaths, admitPackages],
		[
			sealing === "sealed"
				? sealed(unit("Package", { package: int4 }))
				: unit("Package", { package: int4 })
		]
	)

/** The program's schema value, its derivation, and its served program's value. */
interface Built {
	readonly schema: ReturnType<typeof contentOf>
	readonly program: unknown
}

/** The case's schema and program (the header), each head's built by its own code, whose rows its type states. */
const built = (c: ServedCase): Built => {
	const content = contentOf(c.sealing)
	/**
	 * Each package's test roots, every root node of kind 302 with its identifier attribute (name 86): each root's package
	 * and path kept, its path dropped, or its package dropped too.
	 */
	const perPath = query(content).rule((r) => {
		const { package: p, path, start } = v(Node, "node")
		const { value } = v(Attribute, "id")
		return r
			.match(Node, { package: p, path, start, kind: 302, parentKind: 0 })
			.match(Attribute, { package: p, path, start, name: 86, value })
			.find({ package: p, path, identifier: value })
	})
	const perPackage = query(content).rule((r) => {
		const { package: p, path, start } = v(Node, "node")
		const { value } = v(Attribute, "id")
		return r
			.match(Node, { package: p, path, start, kind: 302, parentKind: 0 })
			.match(Attribute, { package: p, path, start, name: 86, value })
			.find({ package: p, identifier: value })
	})
	const across = query(content).rule((r) => {
		const { package: p, path, start } = v(Node, "node")
		const { value } = v(Attribute, "id")
		return r
			.match(Node, { package: p, path, start, kind: 302, parentKind: 0 })
			.match(Attribute, { package: p, path, start, name: 86, value })
			.find({ identifier: value })
	})
	/** The identifiers of the roots of the package a query binds, `roots` imported inside it under an empty bind map. */
	const lessonOf = (roots: typeof perPackage) =>
		query(content).rule((r) => {
			const { identifier } = v(roots, "root")
			return r.match(roots, { package: r.param("package", int4), identifier }).find({ identifier })
		})
	const lessonOfPaths = (roots: typeof perPath) =>
		query(content).rule((r) => {
			const { identifier } = v(roots, "root")
			return r.match(roots, { package: r.param("package", int4), identifier }).find({ identifier })
		})
	/** The learner's visit at a stage, bound by the call's parameters, and each root of its package. */
	const visited = (() => {
		switch (c.head) {
			case "across packages":
				return query(content).rule((r) => {
					const { stage: at, package: p } = v(Visit, "visit")
					const { identifier } = v(across, "root")
					return r
						.match(Visit, { child: r.param("child", int4), stage: at, package: p })
						.match(across, { identifier })
						.find({ stage: at, identifier })
				})
			case "per package":
				return c.placement === "matched"
					? query(content).rule((r) => {
							const { stage: at, package: p } = v(Visit, "visit")
							const { identifier } = v(perPackage, "root")
							return r
								.match(Visit, { child: r.param("child", int4), stage: at, package: p })
								.match(perPackage, { package: p, identifier })
								.find({ stage: at, identifier })
						})
					: query(content).rule((r) => {
							const { stage: at, package: p } = v(Visit, "visit")
							const lesson = lessonOf(perPackage)
							const { identifier } = v(lesson, "lesson")
							return r
								.match(Visit, { child: r.param("child", int4), stage: at, package: p })
								.match(lesson.bind({ package: p }), { identifier })
								.find({ stage: at, identifier })
						})
			case "per path":
				return c.placement === "matched"
					? query(content).rule((r) => {
							const { stage: at, package: p } = v(Visit, "visit")
							const { identifier } = v(perPath, "root")
							return r
								.match(Visit, { child: r.param("child", int4), stage: at, package: p })
								.match(perPath, { package: p, identifier })
								.find({ stage: at, identifier })
						})
					: query(content).rule((r) => {
							const { stage: at, package: p } = v(Visit, "visit")
							const lesson = lessonOfPaths(perPath)
							const { identifier } = v(lesson, "lesson")
							return r
								.match(Visit, { child: r.param("child", int4), stage: at, package: p })
								.match(lesson.bind({ package: p }), { identifier })
								.find({ stage: at, identifier })
						})
		}
	})()
	/**
	 * The rows the call's write inserts: response admission's call over the roots, its argument the roots themselves,
	 * imported under an empty bind map, or the identifiers of the call's package's roots, a query bound to the call's
	 * parameter that imports them.
	 */
	const run = (() => {
		switch (c.head) {
			case "across packages":
				return Fn.row(admitLesson, { roots: across })
			case "per package":
				return c.placement === "matched"
					? Fn.row(admitPackages, { roots: perPackage })
					: Fn.row(admitLesson, { roots: lessonOf(perPackage).bind({ package: lesson }) })
			case "per path":
				return c.placement === "matched"
					? Fn.row(admitPaths, { roots: perPath })
					: Fn.row(admitLesson, { roots: lessonOfPaths(perPath).bind({ package: lesson }) })
		}
	})()
	const admitted = query(content).rule((r) => {
		const read = run.admitted
		const { identifier } = v(read, "admitted")
		return r.match(read, { identifier }).find({ child, stage, identifier })
	})
	switch (c.program) {
		case "read":
			return { schema: content, program: visited }
		case "call":
			return { schema: content, program: ChangeSet.empty(content).insert(Seen, admitted) }
	}
}

/** The call's parameters: the learner and the stage, and the visit's package. */
const child = param("child", int4)
const stage = param("stage", int4)
const lesson = param("package", int4)

/**
 * What the case's served program compiles to (analysis/derived/served.ts): the relations its statement reads, the
 * schema's artifacts admitting its closed imports as a served program's (schema/reach.ts servedImportsOf), as generate's
 * installation and a login's runtime admit them; or its refusal.
 */
export const servedReads = (c: ServedCase): Result.Result<ReadonlyArray<string>, CompileError> => {
	const { schema: schemaValue, program } = built(c)
	const desc = schemaDescOf(schemaValue)
	if (desc === undefined) {
		throw new Error("a built schema's Description")
	}
	return Result.flatMap(servedImportsIn(desc, programDescOf(program)), ({ owned, served }) =>
		Result.flatMap(installBasis(owned, firstCodebook(rostersOf(owned)), served), (basis) =>
			Result.flatMap(baseArtifacts(basis, unserved), (artifacts) =>
				c.program === "read" ? readOf(schemaValue, program, artifacts) : writeOf(program, artifacts)
			)
		)
	)
}

/** A program value's Description: a ChangeSet's, or a read's. */
const programDescOf = (program: unknown): ProgramDesc => {
	const changeSet = changeSetDesc(program)
	if (changeSet !== undefined) {
		return { kind: "changeSet", changeSet }
	}
	const input = queryInput(program)
	if (!input.ok) {
		throw input.error
	}
	return { kind: "query", query: input.value.desc }
}

/**
 * The served imports of a login serving `program` on a role that holds every relation whole, as generate's
 * installation and the login's runtime read them (schema/reach.ts servedImportsOf), with the schema they are of.
 */
const servedImportsIn = (desc: SchemaDesc, program: ProgramDesc) =>
	Result.flatMap(fullRoleDesc(desc, "learner", SourceLoc("served imports", [])), (role) =>
		Result.map(
			Result.flatMap(
				decodeDesc("login", {
					name: "app",
					base: desc,
					roles: [role],
					loc: SourceLoc("served imports", [])
				}),
				ownLogin
			),
			(login) => ({
				owned: login.base,
				served: servedImportsOf(Arr.map(login.roles, (owner) => ({ role: owner, program })))
			})
		)
	)

/** The relations a DAG's Bases read, by name. */
const basesOf = (dag: RelDag): ReadonlyArray<string> =>
	Arr.dedupe(Arr.flatMap(topoOrder(dag), (n) => (n.kind === "Base" ? [n.relation] : [])))

/** The relations a served read reads, compiled as a Db compiles it (program/compile.ts compileQuery). */
const readOf = (schemaValue: unknown, program: unknown, artifacts: SchemaArtifacts) =>
	Result.flatMap(parseSchemaInput(schemaValue), (input) =>
		Result.flatMap(queryInput(program), (q) =>
			Result.flatMap(querySchema(q, input), (source) =>
				Result.map(
					compileQuery(source, {
						context: "snapshot",
						artifacts,
						read: "rows",
						clock: noClock,
						source: transactionClock
					}),
					(template) => basesOf(template.programs.checked.dag)
				)
			)
		)
	)

/** The relations a served write's DAG reads (write/frontend/compile.ts compileChangeSet). */
const writeOf = (program: unknown, artifacts: SchemaArtifacts) => {
	const desc = changeSetDesc(program)
	if (desc === undefined) {
		throw new Error("a ChangeSet value")
	}
	return Result.map(
		compileChangeSet(artifacts.laws.checked, desc, {
			claims: { kind: "every" },
			laws: artifacts.laws,
			derived: artifacts.derived,
			codes: artifacts.names.codes,
			clock: noClock,
			source: transactionClock
		}),
		(frontend) => basesOf(frontend.ir.dag)
	)
}

/**
 * What the case's statement does with its derivation (analysis/derived/served.ts): `stored`, it reads its table, its
 * upkeep reading one path's roots, its package sealed, or, its path dropped under an open package, its delta form
 * monotone over Node and Attribute, closed, a write only gaining roots (analysis/theory/upkeep.ts deltaBoundOf); or
 * `live`, it computes it over the content, reading across packages, local to no unit.
 */
export type Verdict = "stored" | "live"

export const verdictOf = (c: ServedCase): Verdict => {
	switch (c.head) {
		case "per path":
		case "per package":
			return "stored"
		case "across packages":
			return "live"
	}
}
