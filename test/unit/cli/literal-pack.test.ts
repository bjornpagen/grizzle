import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, DateTime, Effect, FileSystem, Option, Order, String as Str } from "effect"
import { refusalText } from "#cli/refusals.ts"
import { metaFileName } from "#compiler/deploy/render/folder.ts"
import { splitStatements } from "#compiler/deploy/render/markers.ts"
import { snapshotFileName } from "#compiler/deploy/snapshot/types.ts"
import { compileInstallation, installOptions } from "#compiler/physical/install/compile.ts"
import { closedId } from "#compiler/public/fields.ts"
import { closed, schema } from "#compiler/public/schema.ts"
import { printObjectName, printStatement } from "#compiler/sql/print.ts"
import { defineConfig } from "#index.ts"
import { cliOver, configName, offlineOwner, workspace } from "#test/pg/cli/support.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { owning } from "#test/support/policy.ts"

/**
 * A closed relation declared `pack: "hex"` through the command line: `grizzle generate` drafts its constant as one
 * literal pack, the installation's own, and no row of it; `grizzle check` holds the literal to its content
 * (physical/ddl/literal.ts literalPackFault), so the drafted folder passes, one hex digit changed is refused at its file
 * and statement, naming the closed relation, the first cell where the literal parts from the rows the schema declares
 * and that cell's key, and a literal out of its printed form is refused at its file and statement too.
 *
 * Oracle: the grid's cells by hand, row-major: (r0, c0) is cell 0, which the first hex digit's first bit lies in.
 */
const Row = closed("Row", ["r0", "r1", "r2"])
const Col = closed("Col", ["c0", "c1"])
const Mark = closed("Mark", ["low", "high", "top"])
const Grid = closed.relation(
	"Grid",
	{ row: closedId(Row), col: closedId(Col), mark: closedId(Mark) },
	["row", "col"],
	[
		{ row: "r0", col: "c0", mark: "low" },
		{ row: "r0", col: "c1", mark: "top" },
		{ row: "r2", col: "c1", mark: "high" }
	],
	{ pack: "hex" }
)
const gridSchema = schema("LitGrid", { Row, Col, Mark, Grid }, [])

const config = defineConfig({
	schemas: [gridSchema],
	logins: [],
	migrations: "migrations",
	connection: offlineOwner
})

const now = (s: number) =>
	DateTime.makeUnsafe({
		year: 2026,
		month: 11,
		day: 5,
		hour: 12,
		minute: 0,
		second: s,
		millisecond: 0
	})

/** The lines of an output, each `<where>: <problem>; <fix>` for a finding. */
const lines = (text: string): ReadonlyArray<string> =>
	Arr.filter(Str.split(text, "\n"), (l) => l.length > 0)

/** The grid's pack as its installation plans it, which generate drafts: its literal, as the grid declares. */
const owned = owning(gridSchema)
const installation = succeeded(compileInstallation(owned, installOptions(owned, undefined)))
const fn = installation.names.closed("Grid").function
const literal = defined(
	Arr.flatMap(installation.statements, (s) =>
		s.kind === "packConstant" && s.function.name === fn.name ? [s] : []
	)[0],
	"the grid's pack"
)
const hex = literal.form.kind === "literal" ? literal.form.hex : ""

layer(NodeServices.layer, { excludeTestServices: true })(
	"grizzle check over a literal pack",
	(it) => {
		it.effect(
			"passes a drafted literal, and refuses a changed digit and a broken form at its file and statement",
			() =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					assert.equal(literal.form.kind, "literal", "a pack declared hex is its literal")
					const ws = yield* workspace("literal-pack")
					const drafted = yield* cliOver(
						ws,
						config,
						["generate", configName, "--name", "init"],
						now(0)
					)
					assert.equal(drafted.code, 0, drafted.stderr)
					const schemaDir = `migrations/${owned.installation.identifier}`
					const entries = yield* fs.readDirectory(`${ws}/${schemaDir}`)
					const folders = Arr.filter(entries, (n) => n !== snapshotFileName)
					const folder = `${schemaDir}/${defined(folders[0], "the drafted folder")}`
					const named = yield* fs.readDirectory(`${ws}/${folder}`)
					const files = Arr.sort(
						Arr.filter(named, (n) => n !== metaFileName),
						Order.String
					)
					const literalText = printStatement(literal)
					const texts = yield* Effect.forEach(files, (name) =>
						Effect.map(fs.readFileString(`${ws}/${folder}/${name}`), (text) => ({ name, text }))
					)
					const file = defined(
						Option.getOrUndefined(Arr.findFirst(texts, (f) => Str.includes(literalText)(f.text))),
						"the file generate drafted the grid's literal into"
					)
					assert.ok(
						!Arr.some(texts, (f) => Str.includes("LEFT JOIN (VALUES")(f.text)),
						"no file lists the grid's rows"
					)
					const stated = file.text
					const index = defined(
						Option.getOrUndefined(
							Arr.findFirstIndex(splitStatements(stated), (s) => Str.includes(`X'${hex}'`)(s))
						),
						"the literal is one of the file's statements"
					)
					const ordinal = index + 1
					const path = `${ws}/${folder}/${file.name}`
					const where = `${folder}/${file.name}: statement ${ordinal}`
					const refusal = `${refusalText.literalPack.problem}; ${refusalText.literalPack.fix}`

					const held = yield* cliOver(ws, config, ["check", configName], now(1))
					assert.equal(held.code, 0, held.stderr)

					const digit = Number.parseInt(Str.slice(0, 1)(hex), 16) ^ 8
					const changed = `X'${Str.toUpperCase(digit.toString(16))}${Str.slice(1)(hex)}'`
					yield* fs.writeFileString(path, Str.replace(`X'${hex}'`, changed)(stated))
					const tampered = yield* cliOver(ws, config, ["check", configName], now(2))
					assert.equal(tampered.code, 1)
					assert.deepEqual(lines(tampered.stderr), [
						`${where}: the literal of ${printObjectName(fn)} (closed relation Grid) differs from its declared rows, first at cell 0, key (r0, c0): ${refusal}`
					])

					yield* fs.writeFileString(path, Str.replace(`X'${hex}'`, `Y'${hex}'`)(stated))
					const broken = yield* cliOver(ws, config, ["check", configName], now(3))
					assert.equal(broken.code, 1)
					assert.deepEqual(lines(broken.stderr), [
						`${where}: a statement that begins as a literal pack's comment departs from its printed form: ${refusal}`
					])
				})
		)
	}
)
