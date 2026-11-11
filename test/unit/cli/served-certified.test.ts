import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { element, type Gen, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Record as Rec, String as Str } from "effect"
import { compileSchema, resolveConfig } from "#cli/config.ts"
import { draftSchema, servedFiles } from "#cli/generate.ts"
import { trustedJson } from "#compiler/core/trusted.ts"
import { emptySnapshot } from "#compiler/deploy/snapshot/build.ts"
import { isolationTrigger } from "#compiler/physical/ddl/isolation.ts"
import { grantedPrivileges } from "#compiler/physical/ddl/roles.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { type AnyLogin, login, wholeEntriesOf } from "#compiler/public/schema.ts"
import { role } from "#compiler/schema/world.ts"
import { servedFile } from "#compiler/served/json.ts"
import { defineConfig } from "#index.ts"
import { offlineOwner } from "#test/pg/cli/support.ts"
import {
	Budget,
	Node,
	Order,
	Pool,
	Tag,
	Task,
	Ticket,
	Work
} from "#test/support/agreement/changeset-schema.ts"
import { assert, defined } from "#test/support/assert.ts"
import { repoRoot } from "#test/support/files.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"

/**
 * Each role's isolation level is decided once, in the draft's workload plan, from the statements its served writes
 * send (program/isolation/certification.ts), and reaches everything that runs by it alike: the role's served file
 * records it and projects its writes at it, and the installation holds it, which its tables' guards follow.
 *
 * The box: the ChangeSet agreement's Work (test/support/agreement/changeset-schema.ts) configured alone, one login
 * over it whose writer holds every relation of Work whole and writes a drawn nonempty set of them, under `insert` or
 * `write`, and runs an insert of each relation of a drawn nonempty subset of them, every member supplied by the call;
 * beside it a reader of Work that writes nothing; and beside that login, as a drawn direct writer, none or a login whose
 * one role has no change member and inserts, or writes, a drawn nonempty set of the same relations, as psql does. The
 * relations written cover every kind of field and law Work holds: a closed id, a set and texts (Tag), a serial
 * (Ticket), a contract (Budget), a plain relation (Task), an immutable family owner (Order, Pool) and a tree (Node).
 *
 * Properties, over the draft's own plan as generate and check compile it (draftSchema, then servedFiles):
 *
 * - Names: every reason any certificate gives names a relation of Work, never a table, a function or a statement the
 *   names grizzle installs leave unresolved (`?schema.name`, `?function:...`, `?statement:...`), so every object a
 *   compiled write of a whole entry reaches is one the certifier reads facts of.
 * - Levels: each role's level in its served file is its certificate's, and so is its level in the installation.
 * - A role with no change member is SERIALIZABLE.
 * - Guards: every relation a READ COMMITTED role holds INSERT on has no guard trigger in the installation
 *   (physical/ddl/isolation.ts readCommittedRelations), so none of its writes is refused below SERIALIZABLE: a role
 *   writing a relation a SERIALIZABLE role writes too is SERIALIZABLE. Kept: an inserter of Tag beside a direct
 *   inserter of Tag, which certified READ COMMITTED while Tag kept its guard.
 */

type Mode = "insert" | "write"

/**
 * A relation of Work a writer may insert, with every relation its insert writes, which the writer's list must hold: a
 * family owner's members with it.
 */
interface Written {
	readonly name: string
	readonly relation:
		| typeof Tag
		| typeof Ticket
		| typeof Budget
		| typeof Task
		| typeof Order
		| typeof Pool
		| typeof Node
	readonly writes: Arr.NonEmptyReadonlyArray<string>
}

const written: Arr.NonEmptyReadonlyArray<Written> = [
	{ name: "Tag", relation: Tag, writes: ["Tag"] },
	{ name: "Ticket", relation: Ticket, writes: ["Ticket"] },
	{ name: "Budget", relation: Budget, writes: ["Budget"] },
	{ name: "Task", relation: Task, writes: ["Task"] },
	{ name: "Order", relation: Order, writes: ["Order", "Line"] },
	{ name: "Pool", relation: Pool, writes: ["Pool", "Item"] },
	{ name: "Node", relation: Node, writes: ["Node"] }
]

/** The relation of the menu of `name`. */
const named = (name: string): Written =>
	defined(
		Option.getOrUndefined(Arr.findFirst(written, (w) => w.name === name)),
		`the written relation ${name}`
	)

/** A direct writer: none, or a role with no change member that inserts, or writes, `writes`. */
type Direct =
	| { readonly kind: "none" }
	| { readonly kind: Mode; readonly writes: Arr.NonEmptyReadonlyArray<Written> }

interface Case {
	readonly mode: Mode
	readonly writes: Arr.NonEmptyReadonlyArray<Written>
	readonly inserts: Arr.NonEmptyReadonlyArray<Written>
	readonly direct: Direct
}

/** A nonempty subset of `values`: one drawn, and any others beside it, in the order `values` holds them. */
const nonEmptySubset =
	<A>(values: Arr.NonEmptyReadonlyArray<A>): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => {
		const first = source.draw(element(values))
		const rest = source.draw(subarray(values))
		return [first, ...Arr.filter(rest, (v) => v !== first)]
	}

const caseGen: Gen<Case> = (source) => {
	const mode = source.draw(element<Mode>(["insert", "write"]))
	const writes = source.draw(nonEmptySubset(written))
	const inserts = source.draw(nonEmptySubset(writes))
	const direct = source.draw(element<Direct["kind"]>(["none", "insert", "write"]))
	return {
		mode,
		writes,
		inserts,
		direct:
			direct === "none"
				? { kind: "none" }
				: { kind: direct, writes: source.draw(nonEmptySubset(written)) }
	}
}

type Feature =
	| "an insert role"
	| "a write role"
	| "a role certified READ COMMITTED"
	| "a role certified SERIALIZABLE for its own statements"
	| "a role with no change member"
	| "a direct writer of a relation the writer writes"

const file = `${repoRoot}app/grizzle.config.ts`

layer(NodeServices.layer, { excludeTestServices: true })("a role's isolation level", (it) => {
	it.effect(
		"is decided once from the statements its writes send, every name they reach resolved, and its served file and the installation hold it alike",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/cli/served-certified",
						draw: drawn(caseGen),
						literal: (c) => {
							const list = (ws: ReadonlyArray<Written>) =>
								`[${Arr.join(
									Arr.map(ws, (w) => `named(${Formatter.format(w.name)})`),
									", "
								)}]`
							const direct =
								c.direct.kind === "none"
									? `{ kind: "none" }`
									: `{ kind: ${Formatter.format(c.direct.kind)}, writes: ${list(c.direct.writes)} }`
							return `{ mode: ${Formatter.format(c.mode)}, writes: ${list(c.writes)}, inserts: ${list(c.inserts)}, direct: ${direct} }`
						},
						oracle: {
							kind: "second-implementation",
							name: "the certificates the plan holds, against the names grizzle installs and the levels the served files and the installation record"
						},
						coverage: required<Feature>(
							[
								"an insert role",
								"a write role",
								"a role certified READ COMMITTED",
								"a role certified SERIALIZABLE for its own statements",
								"a role with no change member",
								"a direct writer of a relation the writer writes"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [
							{
								note: "an inserter of Tag beside a direct inserter of Tag, certified READ COMMITTED while Tag kept its guard",
								sketch: {
									mode: "insert",
									writes: [named("Tag")],
									inserts: [named("Tag")],
									direct: { kind: "insert", writes: [named("Tag")] }
								},
								draws: "",
								reaches: [
									"an insert role",
									"a direct writer of a relation the writer writes",
									"a role certified SERIALIZABLE for its own statements",
									"a role with no change member"
								]
							}
						],
						runs: 24,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					(c, notes) =>
						Effect.gen(function* () {
							notes.note(c.mode === "insert" ? "an insert role" : "a write role")
							const names = Arr.flatMap(c.writes, (w) => w.writes)
							const writer = role(
								Work,
								"writer",
								wholeEntriesOf(Work),
								c.mode === "insert" ? { insert: names } : { write: names }
							)
							const reader = role(Work, "reader", wholeEntriesOf(Work))
							const programs = Rec.fromEntries(
								Arr.map(
									c.inserts,
									(w) => [`add${w.name}`, ChangeSet.empty(writer).insert(w.relation, [])] as const
								)
							)
							const app = login(Work, "app", [writer, reader], {
								workload: [workload(writer, programs)]
							})
							const direct = c.direct
							const psql =
								direct.kind === "none"
									? []
									: [
											login(Work, "psql", [
												role(
													Work,
													"direct",
													wholeEntriesOf(Work),
													direct.kind === "insert"
														? { insert: Arr.flatMap(direct.writes, (w) => w.writes) }
														: { write: Arr.flatMap(direct.writes, (w) => w.writes) }
												)
											])
										]
							if (
								direct.kind !== "none" &&
								Arr.some(direct.writes, (d) => Arr.some(c.writes, (w) => w.name === d.name))
							) {
								notes.note("a direct writer of a relation the writer writes")
							}
							const config = yield* resolveConfig(
								defineConfig({
									schemas: [Work],
									logins: [app, ...psql],
									migrations: "migrations",
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
								noDeclarations
							)
							const served = draft.served
							assert.ok(served.kind === "logins", "a schema with a login plans its logins")
							const entries = yield* servedFiles(compiled, draft.snapshotFiles, served)
							const installation = draft.installation
							const guarded = new Set(
								Arr.flatMap(installation.manifest.objects, (o) =>
									o.kind === "isolationTrigger" ? [o.ident] : []
								)
							)
							for (const certified of served.certification) {
								const reasons =
									certified.certificate.level === "serializable"
										? certified.certificate.reasons
										: []
								for (const reason of reasons) {
									if (reason.relation !== undefined) {
										assert.ok(
											!Str.startsWith("?")(reason.relation),
											`role ${certified.role}: ${reason.relation} is an object the installed names resolve`
										)
									}
								}
								if (certified.certificate.level === "readCommitted") {
									notes.note("a role certified READ COMMITTED")
								} else if (Arr.some(reasons, (r) => r.condition === "members")) {
									notes.note("a role with no change member")
								} else {
									notes.note("a role certified SERIALIZABLE for its own statements")
								}
								const entry = defined(
									Arr.findFirst(entries, (e) => e.login === certified.login).pipe(
										Option.getOrUndefined
									),
									`the served file of login ${certified.login}`
								)
								const servedRole = Option.getOrUndefined(
									Arr.findFirst(
										servedFile(trustedJson<unknown>(entry.text)).roles,
										(r) => r.name === certified.role
									)
								)
								assert.equal(
									defined(servedRole, `the served role ${certified.role}`).isolation,
									certified.certificate.level,
									`role ${certified.role}: its served file records its certificate's level`
								)
								const installed = Option.getOrUndefined(
									Arr.findFirst(
										draft.installation.certification,
										(i) => i.login === certified.login && i.role === certified.role
									)
								)
								assert.equal(
									defined(installed, `the installation's level of ${certified.role}`).certificate
										.level,
									certified.certificate.level,
									`role ${certified.role}: the installation holds its certificate's level`
								)
								if (certified.certificate.level === "readCommitted") {
									const checked = defined(
										Arr.findFirst(
											Arr.flatMap(installation.logins, (l) =>
												l.login.name === certified.login ? l.roles : []
											),
											(r) => r.checked.world.role.name === certified.role
										).pipe(Option.getOrUndefined),
										`the installed role ${certified.role}`
									)
									for (const [relation, held] of grantedPrivileges(
										installation.laws,
										checked.checked
									)) {
										if (held.has("INSERT")) {
											assert.ok(
												!guarded.has(
													isolationTrigger(
														installation.names.schema,
														installation.names.relation(relation)
													).ident
												),
												`role ${certified.role} runs READ COMMITTED and ${relation}, which it inserts, has no guard`
											)
										}
									}
								}
							}
							const logins: ReadonlyArray<AnyLogin> = [app, ...psql]
							assert.deepEqual(
								Arr.sort(
									Arr.map(served.certification, (r) => `${r.login}.${r.role}`),
									Str.Order
								),
								Arr.sort(
									Arr.flatMap(logins, (l) => Arr.map(Rec.keys(l.roles), (r) => `${l.name}.${r}`)),
									Str.Order
								),
								"a certificate for each role of each login"
							)
						})
				)
			)
	)
})
