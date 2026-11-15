/**
 * A write's nested sources (runtime/write/bind.ts, runtime/write/staged.ts NestedSource): every stratum's nested rows
 * of a relation that a statement of the flight sends are built once for the write, each column of them written whole
 * and measured once, and every statement that sends them reads that one source. Sharing is invisible on the wire: each
 * statement's executions, every Bind's text and parameters, are byte for byte the ones it sends as its flight's only
 * statement, where no other statement's source exists to share, so its cells, its arrays and its measures are its
 * own, built for it alone: the per-statement form the write's sources replace.
 *
 * The schema holds pantry's import shape beside a ledger and a tree: a Package whose ordered Entry family carries bytes
 * and a path, each entry a counted member of a Bin the write inserts and of a mutable Shelf it does not, each folding
 * its entries' sizes, and each entry owning an ordered family of Chunks; a mutable Doc whose ordered Lines fold their
 * quantities into its total; and a tree of Nodes. A case inserts up to two packages of up to three entries, each of a
 * drawn bin, shelf and length of bytes and up to two chunks of drawn bodies, up to two docs of up to two lines of drawn
 * notes, and up to two trees of up to four nodes, so one stratum nests several relations' rows, each relation's rows
 * one source. Every statement is cut under the transport in force or under a drawn message bound, past which its
 * nested rows travel through its staged form's carriers in chunks, and a row no fill carries even alone is refused.
 *
 * Oracle: a second derivation, the per-statement form. The write is bound once, and each statement's executions
 * (BoundWrite flights' chunks) must equal, refusals included, those of the same statement bound alone in a flight of
 * its own under the same inputs and transport.
 *
 * Features: several sources in one stratum, a statement inline, a statement staged in several fills, a row past one
 * fill alone, an owner of no member.
 *
 * @plant test/plants/unit/write/nested-sources-keyed-by-stratum.patch the write's sources are keyed by their stratum
 * alone, so each statement of a stratum sends the first source built there, another relation's rows; the property
 * fails.
 */
import { type Case, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, type Gen, int, parents, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { collectInputs } from "#adapter/apply/collect.ts"
import { bindFrame } from "#adapter/wire/batch.ts"
import {
	accumulated,
	bytes,
	drawn as drawnField,
	natural,
	pg,
	uuid
} from "#compiler/public/fields.ts"
import {
	counted,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	schema,
	tree
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { bindWrite, type RunnableWrite } from "#compiler/runtime/write/bind.ts"
import type { FlightStatement } from "#compiler/runtime/write/flight.ts"
import { inForce, type Transport } from "#compiler/runtime/write/transport.ts"
import { changeSetOver as ChangeSet } from "#compiler/write/changeset/value.ts"
import { runnableWrite } from "#compiler/write/program/bind.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { assert, assertVariant, defined, succeeded } from "#test/support/assert.ts"
import { realityWrite, testArtifacts, testCompile } from "#test/support/compile.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking } from "#test/support/policy.ts"
import { descOf, parsedOf, uuidOf } from "#test/unit/write/changeset/fixtures.ts"

/** A path, a chunk's body or a line's note: up to eight letters. */
const Letters = str.regex("^[a-z]{0,8}$")

const Package = relation("Package", { id: uuid, entries: drawnField(natural) }, ["id"])
const Bin = relation(
	"Bin",
	{ id: uuid, n: drawnField(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const Shelf = relation(
	"Shelf",
	{ id: uuid, n: drawnField(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const Entry = relation(
	"Entry",
	{
		package: uuid,
		at: drawnField(natural),
		path: Letters,
		bin: uuid,
		shelf: uuid,
		size: pg.bigint,
		chunks: drawnField(natural),
		content: bytes
	},
	["package", "path"]
)
const Chunk = relation(
	"Chunk",
	{ package: uuid, path: Letters, at: drawnField(natural), body: Letters },
	["package", "path", "at"]
)
const Doc = relation(
	"Doc",
	{ id: uuid, lines: drawnField(natural), total: accumulated(pg.bigint, 0n) },
	["id"]
)
const Line = relation(
	"Line",
	{ id: uuid, doc: uuid, at: drawnField(natural), qty: pg.bigint, note: Letters },
	["id"]
)
const Node = relation(
	"Node",
	{
		root: uuid,
		parent: drawnField(natural),
		at: drawnField(natural),
		children: drawnField(natural),
		start: drawnField(natural),
		end: drawnField(natural),
		label: pg.bigint
	},
	["root", "start"]
)
const binned = counted(on(Entry, "bin"), fin(Bin, "n"))
const shelved = counted(on(Entry, "shelf"), fin(Shelf, "n"))
const lines = ordered(on(Line, "doc", "at"), fin(Doc, "lines"))
const Sources = schema(
	"NestedSources",
	[Package, Bin, Shelf, Entry, Chunk, Doc, Line, Node],
	[
		ordered(on(Entry, "package", "at"), fin(Package, "entries")),
		binned,
		fold(binned, Monoid.sum, on(Entry, "bin", "size"), on(Bin, "id", "total")),
		mutable(Shelf),
		shelved,
		fold(shelved, Monoid.sum, on(Entry, "shelf", "size"), on(Shelf, "id", "total")),
		ordered(on(Chunk, "package", "path", "at"), fin(Entry, "chunks")),
		mutable(Doc),
		lines,
		fold(lines, Monoid.sum, on(Line, "doc", "qty"), on(Doc, "id", "total")),
		tree(on(Node, "parent", "at"), fin(Node, "children"), { root: ["root"] })
	]
)

const reality = realityWrite(succeeded(testArtifacts(Sources, testCompile)))

/** An entry: its bin and shelf among two each, its size, its bytes' length and each chunk's body length. */
interface EntrySketch {
	readonly bin: number
	readonly shelf: number
	readonly size: number
	readonly content: number
	readonly chunks: ReadonlyArray<number>
}

/** The bound statements are cut under: the transport in force, or a drawn message bound in bytes. */
type Cut = { readonly kind: "in force" } | { readonly kind: "drawn"; readonly bytes: number }

/** A case: each package's entries, each doc's lines' note lengths, each tree's parents, and the cut. */
interface Sketch {
	readonly packages: ReadonlyArray<ReadonlyArray<EntrySketch>>
	readonly docs: ReadonlyArray<ReadonlyArray<number>>
	readonly trees: ReadonlyArray<ReadonlyArray<number>>
	readonly cut: Cut
}

const entryGen: Gen<EntrySketch> = (source) => ({
	bin: source.draw(int(0, 1)),
	shelf: source.draw(int(0, 1)),
	size: source.draw(int(0, 9)),
	content: source.draw(int(0, 400)),
	chunks: source.draw(array(int(0, 8), { min: 0, max: 2 }))
})

const cutGen: Gen<Cut> = weighted<Cut>([
	[1, (): Cut => ({ kind: "in force" })],
	[3, (source): Cut => ({ kind: "drawn", bytes: source.draw(int(400, 4_000)) })]
])

const sketchGen: Gen<Sketch> = (source) => ({
	packages: source.draw(array(array(entryGen, { min: 0, max: 3 }), { min: 0, max: 2 })),
	docs: source.draw(array(array(int(0, 8), { min: 0, max: 2 }), { min: 0, max: 2 })),
	trees: source.draw(array(parents({ min: 0, max: 3 }), { min: 0, max: 2 })),
	cut: source.draw(cutGen)
})

/** A letter repeated to `length`. */
const lettersOf = (letter: string, length: number): string => Str.repeat(length)(letter)

/** A tree node as its tree's facts nest it: its label and its children. */
interface NodeFact {
	readonly label: bigint
	readonly children: ReadonlyArray<NodeFact>
}

/** A tree's nested facts from its parents (`parents`), node `n` labelled `base + n`. */
const treeFacts = (parentOf: ReadonlyArray<number>, base: number): NodeFact => {
	const kids: Array<Array<number>> = Array.from({ length: parentOf.length + 1 }, () => [])
	for (const [i, p] of parentOf.entries()) {
		defined(kids[p], "a parent").push(i + 1)
	}
	const built = (n: number): NodeFact => ({
		label: BigInt(base + n),
		children: Arr.map(defined(kids[n], "a node's children"), built)
	})
	return built(0)
}

/** The case's ChangeSet: the two bins, its packages with their entries and chunks, its docs with their lines, and its
 * trees, each relation inserted only where the case holds a fact of it. */
const changeOf = (sketch: Sketch) => {
	const bins = Arr.map([0, 1], (b) => ({ id: uuidOf(10 + b) }))
	const packages = Arr.map(sketch.packages, (entriesOf, p) => ({
		id: uuidOf(100 + p),
		entries: Arr.map(entriesOf, (e, i) => ({
			path: lettersOf("p", i + 1),
			bin: uuidOf(10 + e.bin),
			shelf: uuidOf(20 + e.shelf),
			size: BigInt(e.size),
			content: new Uint8Array(e.content).fill((p * 7 + i) % 251),
			chunks: Arr.map(e.chunks, (length) => ({ body: lettersOf("c", length) }))
		}))
	}))
	const docs = Arr.map(sketch.docs, (notes, d) => ({
		id: uuidOf(200 + d),
		lines: Arr.map(notes, (length, i) => ({
			id: uuidOf(300 + 10 * d + i),
			qty: BigInt(i),
			note: lettersOf("n", length)
		}))
	}))
	const roots = Arr.map(sketch.trees, (parentOf, t) => ({
		...treeFacts(parentOf, 400 + 10 * t),
		root: uuidOf(900 + t)
	}))
	const withBins = ChangeSet.empty(Sources).insert(Bin, bins)
	const withPackages = packages.length === 0 ? withBins : withBins.insert(Package, packages)
	const withDocs = docs.length === 0 ? withPackages : withPackages.insert(Doc, docs)
	return roots.length === 0 ? withDocs : withDocs.insert(Node, roots)
}

/** The transport a case's statements are cut under. */
const transportOf = (cut: Cut): Transport =>
	cut.kind === "in force" ? inForce(bindFrame) : { ...inForce(bindFrame), messageBytes: cut.bytes }

type Feature =
	| "several sources in one stratum"
	| "a statement inline"
	| "a statement staged in several fills"
	| "a row past one fill alone"
	| "an owner of no member"

/** The form and the chunks of a write a case's facts bind: lawful by construction, it binds, and it reads nothing first,
 * every group it writes its own new owner's or a stored owner's its one flight recounts. */
const boundOf = (result: ReturnType<typeof bindWrite>) => {
	const bound = succeeded(result, "the case's facts bind")
	assertVariant(bound, "kind", "bound", "the case's facts are lawful")
	assertVariant(bound.flights, "kind", "write", "a nested insert reads nothing first")
	return { form: bound.form, chunks: bound.flights.chunks }
}

/** The header's property over one case. */
const property = (sketch: Sketch, c: Case<Feature>) =>
	Effect.gen(function* () {
		const value = changeOf(sketch)
		const program = succeeded(compileWrite(checking(Sources), descOf(value), reality))
		const members = yield* collectInputs(program.binding.groups, parsedOf(value).inputs)
		const runnable = runnableWrite(program, program.frontend.codes)
		const bind = (write: RunnableWrite) =>
			boundOf(bindWrite(write, { members, params: {}, transport: inForce(bindFrame) }))
		const whole = bind(runnable)
		const transport = transportOf(sketch.cut)
		const alone = (statement: FlightStatement) =>
			bind({ ...runnable, flight: { ...runnable.flight, statements: [statement] } }).chunks(
				statement,
				transport
			)
		const sources = new Set<string>()
		for (const statement of runnable.flight.statements) {
			const sent = Arr.flatMap(whole.form(statement).paramSlots, (slot) =>
				slot.kind === "nestedRows" ? [`${slot.stratum} ${slot.relation}`] : []
			)
			for (const source of sent) {
				sources.add(source)
			}
			const got = whole.chunks(statement, transport)
			assert.deepEqual(
				got,
				alone(statement),
				`statement ${statement.index} sends what it sends as its flight's only statement`
			)
			if (sent.length === 0) {
				continue
			}
			if (!got.ok) {
				c.note("a row past one fill alone")
				continue
			}
			if (got.value.length === 1) {
				c.note("a statement inline")
			}
			if (Arr.filter(got.value, (e) => e.part === "fill").length > 1) {
				c.note("a statement staged in several fills")
			}
		}
		if (sources.size > 1) {
			c.note("several sources in one stratum")
		}
		if (
			Arr.some(
				sketch.packages,
				(es) => es.length === 0 || Arr.some(es, (e) => e.chunks.length === 0)
			) ||
			Arr.some(sketch.docs, (ls) => ls.length === 0)
		) {
			c.note("an owner of no member")
		}
	})

describe("a write's nested sources", () => {
	it.effect(
		"send every statement the bytes it sends as its flight's only statement, inline and staged",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/write/nested-sources",
						draw: drawn(sketchGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "each statement's executions bound alone in a flight of its own"
						},
						coverage: required<Feature>(
							[
								"several sources in one stratum",
								"a statement inline",
								"a statement staged in several fills",
								"a row past one fill alone",
								"an owner of no member"
							],
							{ cases: 48, sense: notesOnly }
						),
						kept: [],
						runs: 64,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 8,
						caseHang
					},
					property
				)
			)
	)
})
