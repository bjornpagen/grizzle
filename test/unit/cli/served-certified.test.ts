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
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { login, wholeEntriesOf } from "#compiler/public/schema.ts"
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
 * beside it a reader of Work that writes nothing. The relations written cover every kind of field and law Work holds:
 * a closed id, a set and texts (Tag), a serial (Ticket), a contract (Budget), a plain relation (Task), an immutable
 * family owner (Order, Pool) and a tree (Node).
 *
 * Properties, over the draft's own plan as generate and check compile it (draftSchema, then servedFiles):
 *
 * - Names: every reason any certificate gives names a relation of Work, never a table, a function or a statement the
 *   names grizzle installs leave unresolved (`?schema.name`, `?function:...`, `?statement:...`), so every object a
 *   compiled write of a whole entry reaches is one the certifier reads facts of.
 * - Levels: each role's level in its served file is its certificate's, and so is its level in the installation.
 * - A role with no change member is SERIALIZABLE.
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

interface Case {
	readonly mode: Mode
	readonly writes: Arr.NonEmptyReadonlyArray<Written>
	readonly inserts: Arr.NonEmptyReadonlyArray<Written>
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
	return { mode, writes, inserts: source.draw(nonEmptySubset(writes)) }
}

type Feature =
	| "an insert role"
	| "a write role"
	| "a role certified READ COMMITTED"
	| "a role certified SERIALIZABLE for its own statements"
	| "a role with no change member"

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
						literal: (c) =>
							Formatter.format({
								mode: c.mode,
								writes: Arr.map(c.writes, (w) => w.name),
								inserts: Arr.map(c.inserts, (w) => w.name)
							}),
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
								"a role with no change member"
							],
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
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
							const config = yield* resolveConfig(
								defineConfig({
									schemas: [Work],
									logins: [app],
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
							const entry = defined(entries[0], "the login's served file")
							const servedJson = servedFile(trustedJson<unknown>(entry.text))
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
								const servedRole = Option.getOrUndefined(
									Arr.findFirst(servedJson.roles, (r) => r.name === certified.role)
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
							}
							assert.equal(
								served.certification.length,
								2,
								"a certificate for each role of the login"
							)
						})
				)
			)
	)
})
