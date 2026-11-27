/** What served-seeks.test.ts reads: its box, the draft of its login as generate makes it, and the specification. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Formatter,
	Option,
	Record as Rec,
	String as Str
} from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, eachServedFile } from "#cli/generate.ts"
import { silentPhases } from "#compiler/core/phase.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { printedSeeks, type SeekTable, type SeekTargets } from "#compiler/physical/access/seeks.ts"
import { variantsEntries } from "#compiler/program/workload/change.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { param, query, v } from "#compiler/public/query.ts"
import {
	closed,
	login,
	mutable,
	relation,
	schema,
	unit,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { roleBuilder as role } from "#compiler/schema/world.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import { repoRoot } from "#test/support/files.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * The change members of the box's one role: an insert of R and of Tag, a put of R from a relation parameter, a delete
 * of R's rows at a value of v and at a key, and a read-back of every R with its tag, and of one Tag at its key.
 */
const memberKinds = [
	"insertR",
	"insertTag",
	"putR",
	"deleteAtV",
	"deleteAtK",
	"readBackTagged",
	"readBackOne"
] as const

export type MemberKind = (typeof memberKinds)[number]

/** A case: the members the role serves, each once. */
export interface Case {
	readonly members: Arr.NonEmptyReadonlyArray<MemberKind>
}

export const caseGen: Gen<Case> = (source) => {
	const first = source.draw(element(memberKinds))
	return {
		members: [
			first,
			...Arr.filter(
				Arr.dedupe(source.draw(array(element(memberKinds), { min: 0, max: 3 }))),
				(m) => m !== first
			)
		]
	}
}

const Kind = closed.ordered("Kind", ["Low", "High"])
const R = relation("R", { k: pg.integer, v: pg.integer, kind: closedId(Kind) }, ["k"])
const Tag = relation("Tag", { r: pg.integer, label: pg.integer }, ["r"])

const Base = schema("served_seeks", [Kind, R, Tag], [unit("Rs", { k: pg.integer }), mutable(R)])

/** The box's role, one a case's login holds alone: every relation whole, R written and Tag inserted. */
const writerOf = () => role(Base, "a0", wholeEntriesOf(Base), { insert: ["Tag"], write: ["R"] })

/** The member of kind `kind` of the role `writer`. */
const memberOf = (writer: ReturnType<typeof writerOf>, kind: MemberKind) => {
	switch (kind) {
		case "insertR":
			return ChangeSet.empty(writer).insert(R, [])
		case "insertTag":
			return ChangeSet.empty(writer).insert(Tag, [])
		case "putR":
			return ChangeSet.empty(writer).put(
				R,
				query(writer).rule((q) => {
					const rows = q.relation("rows", { k: R.fields.k, v: R.fields.v, kind: R.fields.kind })
					const { k, v: value, kind: handle } = v(R, "r")
					return q.match(rows, { k, v: value, kind: handle }).find({ k, v: value, kind: handle })
				})
			)
		case "deleteAtV":
			return ChangeSet.empty(writer).deleteWhere({ R: { v: param("v", pg.integer) } })
		case "deleteAtK":
			return ChangeSet.empty(writer).deleteWhere({ R: { k: param("k", pg.integer) } })
		case "readBackTagged":
			return ChangeSet.empty(writer).read("tagged", () =>
				query(writer)
					.rule((q) => {
						const { k, v: value } = v(R, "r")
						return q.match(R, { k, v: value }).find({ k, v: value })
					})
					.attach(
						"tag",
						(row) =>
							query(writer).rule((q) => {
								const { label } = v(Tag, "tag")
								return q.match(Tag, { r: row.k, label }).find({ label })
							}),
						"option"
					)
			)
		case "readBackOne":
			return ChangeSet.empty(writer).read("one", () =>
				query(writer).rule((q) => {
					const { label } = v(Tag, "tag")
					return q.match(Tag, { r: param("r", pg.integer), label }).find({ label })
				})
			)
	}
}

/** A seek as the specification states it: the relation and the fields, which the box installs under their own names. */
export interface Seek {
	readonly relation: "R" | "Tag"
	readonly bound: ReadonlyArray<string>
}

/**
 * The specification: the seeks each member's write makes of the tables it writes and reads, by its semantics, at the
 * least: a write of a relation probes it at its key; a delete at a field reads the relation at it, through the role's
 * view of it, and deletes at the keys of the rows it found; a read-back reads Tag at its key, at each R's or at the
 * call's.
 */
export const specified: Readonly<Record<MemberKind, ReadonlyArray<Seek>>> = {
	insertR: [{ relation: "R", bound: ["k"] }],
	insertTag: [{ relation: "Tag", bound: ["r"] }],
	putR: [{ relation: "R", bound: ["k"] }],
	deleteAtV: [
		{ relation: "R", bound: ["v"] },
		{ relation: "R", bound: ["k"] }
	],
	deleteAtK: [{ relation: "R", bound: ["k"] }],
	readBackTagged: [{ relation: "Tag", bound: ["r"] }],
	readBackOne: [{ relation: "Tag", bound: ["r"] }]
}

/** The name a member of kind `kind` is served by. */
export const memberName = (kind: MemberKind): string => kind

const file = `${repoRoot}app/grizzle.config.ts`

/** The table of the relation `relation` among `targets`. */
export const tableOf = (targets: SeekTargets, relation: string): SeekTable =>
	defined(
		Option.getOrUndefined(
			Arr.findFirst([...targets.tables.values()], (t) => t.relation === relation)
		),
		`the table of ${relation}`
	)

/** A seek a served write's program makes, as its spelling: its relation and its columns, in order. */
export const spelled = (s: {
	readonly relation: string
	readonly bound: Iterable<string>
}): string => `${s.relation}(${Arr.join(Arr.sort([...s.bound], Str.Order), ", ")})`

/** `targets` with the indexes `drop` names left out of each table: an installation whose extraction missed them. */
export const withoutIndexes = (targets: SeekTargets, drop: ReadonlySet<string>): SeekTargets => ({
	tables: new Map(
		Arr.map(Arr.fromIterable(targets.tables), (entry) => {
			const [key, t] = entry
			const kept: SeekTable = { ...t, indexes: Arr.filter(t.indexes, (i) => !drop.has(i.name)) }
			return [key, kept] as const
		})
	),
	views: targets.views
})

/**
 * The specification of a served seek (physical/access/seeks.ts covers): served where it binds no column of many values,
 * or some index's leading run holds every one it binds, or holds a unique index whole. Every column of the box holds
 * many values but R's kind, a closed id.
 */
export const seekServed = (table: SeekTable, bound: ReadonlySet<string>): boolean => {
	const held = Arr.filter([...bound], (c) => table.holds.get(c) === "many")
	return (
		held.length === 0 ||
		Arr.some(table.indexes, (i) => {
			const run = Arr.takeWhile(i.columns, (c) => bound.has(c))
			return (
				(i.unique && run.length === i.columns.length) || Arr.every(held, (c) => run.includes(c))
			)
		})
	)
}

/**
 * The draft of the case's login from nothing, as `grizzle generate` makes it: the installation's tables and views it
 * drafts (`targets`); `seeksAt`, each member's seeks as its served write's program states them at an installation's
 * tables and views, every variant's; and `serve`, the served files' step of generate (eachServedFile) run over the basis at
 * an installation's tables and views, answering the defect it dies with, none where every login's file is served.
 */
export const drafted = (c: Case) =>
	Effect.gen(function* () {
		const writer = writerOf()
		const app = login(Base, "app", [writer], {
			workload: [
				workload(
					writer,
					Rec.fromEntries(
						Arr.map(c.members, (kind) => [memberName(kind), memberOf(writer, kind)] as const)
					)
				)
			]
		})
		const config = yield* resolveConfig(
			defineConfig({
				contracts: [],
				schemas: [Base],
				logins: [app],
				migrations: "migrations",
				rolePrefixBytes: 0,
				connection: () => offlineOwner
			}),
			file
		)
		const configured = defined(config.schemas[0], "the configured schema")
		const compiled = yield* Effect.fromResult(compileSchema(configured))
		const draft = yield* draftSchema(
			compiled,
			emptySnapshot({ schemaName: configured.declared, schema: configured.ident }),
			[],
			noDeclarations,
			silentPhases
		)
		const served = draft.served
		if (served.kind !== "logins") {
			return yield* Effect.die("a schema with a login plans its logins")
		}
		const planned = defined(served.logins.get("app"), "the login app's plan")
		const roleChanges = defined(planned.roles.get("a0"), "the role a0's change members")
		const programs = new Map(
			Arr.map(c.members, (kind) => {
				const variants = defined(roleChanges.members.get(memberName(kind)), `the member ${kind}`)
				return [kind, Arr.map(variantsEntries(variants), (entry) => entry.compiled.seeks)] as const
			})
		)
		const seeksAt = (kind: MemberKind, targets: SeekTargets) =>
			Arr.flatMap(defined(programs.get(kind), `the member ${kind}`), (program) =>
				printedSeeks(program, targets)
			)
		const serve = (targets: SeekTargets) =>
			Effect.map(
				Effect.exit(
					eachServedFile(
						compiled,
						draft,
						{ ...served, seeks: targets },
						silentPhases,
						Effect.succeed
					)
				),
				(exit) =>
					Exit.isFailure(exit) && Cause.hasDies(exit.cause)
						? Formatter.format(Cause.squash(exit.cause))
						: Exit.isFailure(exit)
							? `a refusal: ${Formatter.format(Cause.squash(exit.cause))}`
							: undefined
			)
		return { targets: served.seeks, seeksAt, serve }
	})
