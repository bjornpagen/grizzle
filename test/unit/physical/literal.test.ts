/**
 * Closed constants stated as bit-string literals (physical/ddl/constants.ts packFormOf, ir/cells.ts literalOf and
 * constantOfLiteral, sql/print.ts writeLiteralPack and readLiteralPack, physical/ddl/literal.ts literalPackFault):
 *
 * - **Both sides of the threshold:** over every small closed relation of a box, a pack is stated as rows exactly while
 *   its row statement and the statement it EXECUTEs fit their bounds, and as its literal one byte past either, the
 *   bounds set at the pack's own sizes. Either form decodes to the relation's cells: the rows to their entries, the
 *   literal through its decoder; the literal's digits expanded four bits each, then its tail, are the cells' bit text
 *   the test oracle writes (bitText); and the printed literal reads back to its own parts, which check holds consistent.
 * - **A tampered literal is refused:** every one-bit change of a dependent relation's literal pack is a content fault
 *   naming the relation, the cell the bit lies in, and the key there, which the dependent sum's enumeration names
 *   independently; a broken form, a dropped digit, a character no digit, a comment's digest or row count edited, and a
 *   literal edited with its comment, which its function's name still refuses, are refused too.
 * - **Across drafts:** from a snapshot that states a relation's packs in either form, a target that states them in
 *   either form drafts no file, since what a constant installs is compared and never its form (deploy/diff/diff.ts
 *   installedContent); a snapshot whose literal its function's name does not digest is refused as malformed.
 *
 * Oracles: the relation's own entries and the bit-text oracle for the forms; the owner-by-owner enumeration of the
 * dependent sum for the cell and key a tamper names; content addressing for the drafts.
 */
import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, pipe, Record as Rec, String as Str } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { maxStringLength } from "#compiler/core/limits.ts"
import { utf8Length } from "#compiler/core/sha256.ts"
import { draftMigration } from "#compiler/deploy/render/generate.ts"
import { emptySnapshot, noWorkload } from "#compiler/deploy/snapshot/build.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"
import {
	type Constant,
	constantDigestOf,
	constantOf,
	constantOfLiteral,
	literalOf,
	type Tuple
} from "#compiler/ir/cells.ts"
import type { ClosedPack } from "#compiler/ir/desc.ts"
import { packFormOf } from "#compiler/physical/ddl/constants.ts"
import { literalPackFault } from "#compiler/physical/ddl/literal.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { closedId, natural, slot, uuid } from "#compiler/public/fields.ts"
import { closed, contained, fin, on, relation, schema } from "#compiler/public/schema.ts"
import type { ObjectName, PackConstant, PackRow } from "#compiler/sql/ast.ts"
import {
	executedPackBytes,
	printObjectName,
	printStatement,
	readLiteralPack,
	statementBytes
} from "#compiler/sql/print.ts"
import {
	artifactRefusal,
	assert,
	containsText,
	defined,
	failed,
	nonEmpty,
	succeeded
} from "#test/support/assert.ts"
import { bitText } from "#test/support/closed/bit-text.ts"
import { literalInstallation, statedAsLiteral } from "#test/support/closed/literal.ts"
import { caseHang } from "#test/support/limits.ts"
import { auditStatementViolations, auditTextViolations } from "#test/support/oracle/verify/sql.ts"
import { ownedInput } from "#test/support/policy.ts"

/** Every point of the space whose coordinates hold `sizes` codes each, first coordinate most significant. */
const odometer = (sizes: ReadonlyArray<number>): ReadonlyArray<ReadonlyArray<number>> => {
	const origin: ReadonlyArray<ReadonlyArray<number>> = [[]]
	return Arr.reduce(sizes, origin, (prefixes, size) =>
		Arr.flatMap(prefixes, (prefix) =>
			Array.from({ length: size }, (_, digit) => [...prefix, digit])
		)
	)
}

/** A literal's bits as PostgreSQL reads `X'<hex>' || B'<tail>'`: each hex digit its four bits, then the tail. */
const expanded = (hex: string, tail: string): string =>
	Arr.join(
		Arr.map(Array.from(hex), (digit) =>
			Str.padStart(4, "0")(Number.parseInt(digit, 16).toString(2))
		),
		""
	) + tail

/** Hex digits with their first bit flipped: the first cell's first bit changed. */
const firstBitFlipped = (hex: string): string =>
	`${Str.toUpperCase((Number.parseInt(Str.slice(0, 1)(hex), 16) ^ 8).toString(16))}${Str.slice(1)(hex)}`

/**
 * The statement a pack of rows' DO block EXECUTEs, as format builds it from the format string its printed EXECUTE
 * line quotes and the cells' bit text `bits`: %L the text quoted, %% one %.
 */
const executedOf = (printed: string, bits: string): string => {
	const line = defined(
		Option.getOrUndefined(
			Arr.findFirst(Str.split(printed, "\n"), (l) => Str.includes("EXECUTE ")(l))
		),
		"the DO block's EXECUTE"
	)
	const opening = `"format"('`
	const start = defined(Option.getOrUndefined(Str.indexOf(opening)(line)), "format's string")
	const end = defined(Option.getOrUndefined(Str.lastIndexOf("'::")(line)), "its cast")
	return pipe(
		Str.slice(start + opening.length, end)(line),
		Str.replaceAll("''", "'"),
		Str.replace("%L", `'${bits}'`),
		Str.replaceAll("%%", "%")
	)
}

/** The cells a pack fills, by its form: its rows' entries, or its literal's decoded ones. */
const cellsOf = (p: PackConstant) =>
	p.form.kind === "rows"
		? Arr.map(p.form.rows, (r) => ({ index: r.index, payload: r.payload }))
		: succeeded(constantOfLiteral({ hex: p.form.hex, tail: p.form.tail }, p.cells, p.width)).entries

/** The function a constant installs: the closed constant its digest names, in a schema of the test's own. */
const functionOf = (constant: Constant): ObjectName => ({
	schema: "literal",
	name: identifierOf(identity.closedConstant(constantDigestOf(constant)))
})

describe("a closed constant's pack", () => {
	type Side =
		| "rows at the bound"
		| "a literal one byte past"
		| "a binary tail"
		| "no cell held"
		| "a payload"

	interface Relation {
		readonly sizes: ReadonlyArray<number>
		readonly payload: number
		readonly held: number
	}

	/**
	 * Every relation over a key of one or two coordinates of 1 to 3 codes, with no payload or one of 3 codes, holding
	 * the cells whose index is congruent to one of a pattern mod 3 (none, every third, two of three, all), each held
	 * cell's payload its index mod the payload's codes: 192 relations.
	 */
	const relations: Gen<Relation> = (s) => ({
		sizes: Array.from({ length: s.draw(int(1, 2)) }, () => s.draw(int(1, 3))),
		payload: s.draw(element([1, 3])),
		held: s.draw(int(0, 3))
	})

	const tuplesOf = (r: Relation): ReadonlyArray<Tuple> =>
		Arr.flatMap(odometer(r.sizes), (key, index) =>
			index % 3 < r.held ? [{ key, payload: r.payload === 1 ? [] : [index % r.payload] }] : []
		)

	const formed = (r: Relation, c: Case<Side>) =>
		Effect.sync(() => {
			const layout = {
				key: { kind: "product", sizes: nonEmpty(r.sizes) },
				payload: r.payload === 1 ? [] : [r.payload]
			} as const
			const constant = succeeded(constantOf(layout, tuplesOf(r)))
			const rows: ReadonlyArray<PackRow> = Arr.map(constant.entries, (e) => ({
				index: e.index,
				payload: e.payload,
				names: [String(e.index)]
			}))
			const fn = functionOf(constant)
			const planned = { constant, rows, digest: constantDigestOf(constant) }
			const unbounded = {
				statementBytes: Number.MAX_SAFE_INTEGER,
				executedBytes: Number.MAX_SAFE_INTEGER
			}
			const asRows = packFormOf(fn, planned, "rows", unbounded)
			const bounds = {
				statementBytes: statementBytes(asRows),
				executedBytes: executedPackBytes(asRows)
			}
			const bits = succeeded(bitText(constant, maxStringLength.value))
			assert.equal(
				bounds.statementBytes,
				utf8Length(printStatement(asRows)),
				"a row statement's measure is its printed text's bytes"
			)
			assert.equal(
				bounds.executedBytes,
				utf8Length(executedOf(printStatement(asRows), bits)),
				"the EXECUTEd statement's measure is the bytes format builds"
			)
			const atBound = packFormOf(fn, planned, "rows", bounds)
			assert.equal(
				atBound.form.kind,
				"rows",
				"a pack whose statements fit their bounds lists its rows"
			)
			const pastStatement = packFormOf(fn, planned, "rows", {
				...bounds,
				statementBytes: bounds.statementBytes - 1
			})
			const pastExecuted = packFormOf(fn, planned, "rows", {
				...bounds,
				executedBytes: bounds.executedBytes - 1
			})
			assert.deepEqual(
				packFormOf(fn, planned, "hex", unbounded),
				pastStatement,
				"a pack declared hex is the literal at any size"
			)
			assert.equal(
				pastStatement.form.kind,
				"literal",
				"a row statement one byte past its bound is a literal"
			)
			assert.equal(
				pastExecuted.form.kind,
				"literal",
				"an EXECUTEd statement one byte past its bound is a literal"
			)
			for (const p of [atBound, pastStatement]) {
				assert.deepEqual(
					cellsOf(p),
					constant.entries,
					`the ${p.form.kind} form decodes to the relation's cells`
				)
			}
			const literal = pastStatement.form
			if (literal.kind !== "literal") {
				return assert.fail("the literal form")
			}
			assert.equal(
				expanded(literal.hex, literal.tail),
				bits,
				"the literal's bits are the cells' bit text"
			)
			assert.equal(literal.rows, rows.length)
			const printed = printStatement(pastStatement)
			assert.deepEqual(
				readLiteralPack(printed),
				{
					function: printObjectName(fn),
					rows: BigInt(rows.length),
					cells: constant.cells,
					width: BigInt(constant.width),
					digest: constantDigestOf(constant),
					hex: literal.hex,
					tail: literal.tail
				},
				"the printed literal reads back to its parts"
			)
			assert.equal(literalPackFault(undefined, printed), undefined, "an untampered literal holds")
			assert.deepEqual(
				[auditStatementViolations(asRows), auditStatementViolations(pastStatement)],
				[[], []],
				"both forms pass the structural audit"
			)
			c.note("rows at the bound")
			c.note("a literal one byte past")
			if (literal.tail !== "") {
				c.note("a binary tail")
			}
			if (rows.length === 0) {
				c.note("no cell held")
			}
			if (r.payload > 1) {
				c.note("a payload")
			}
		})

	it.effect(
		"lists its rows within the statement bounds and states its literal past them, both decoding to its cells",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/physical/literal-forms",
						oracle: {
							kind: "second-implementation",
							name: "the relation's own entries, and the bit text the test oracle writes"
						},
						box: "every relation over 1 or 2 coordinates of 1 to 3 codes, no payload or 3 codes, 4 holding patterns",
						generator: relations,
						literal: Formatter.format,
						limit: 192,
						coverage: requiredInSpace<Side>([
							"rows at the bound",
							"a literal one byte past",
							"a binary tail",
							"no cell held",
							"a payload"
						]),
						caseHang
					},
					formed
				)
			)
	)

	it("states a constant of no cell as B'' alone, which reads back and holds", () => {
		const constant: Constant = { cells: 0n, width: 1, entries: [] }
		const fn = functionOf(constant)
		const printed = printStatement(
			packFormOf(fn, { constant, rows: [], digest: constantDigestOf(constant) }, "hex", {
				statementBytes: 0,
				executedBytes: 0
			})
		)
		containsText(printed, "RETURN B''::bit varying")
		assert.deepEqual(readLiteralPack(printed), {
			function: printObjectName(fn),
			rows: 0n,
			cells: 0n,
			width: 1n,
			digest: constantDigestOf(constant),
			hex: "",
			tail: ""
		})
		assert.equal(literalPackFault(undefined, printed), undefined)
	})
})

describe("a tampered literal pack", () => {
	const Version = closed("Version", ["v0", "v1"])
	const Kind = closed("Kind", ["k0", "k1"])
	const Position = closed("Position", ["p0", "p1", "p2"])
	/** Each owner's count: (v0, k0) 2, (v0, k1) none, (v1, k0) 3, (v1, k1) 1. */
	const counts = [2, 0, 3, 1] as const
	const owners = [
		["v0", "k0"],
		["v0", "k1"],
		["v1", "k0"],
		["v1", "k1"]
	] as const
	const Model = closed.relation(
		"Model",
		{ version: closedId(Version), parent: closedId(Kind), positions: natural },
		["version", "parent"],
		Arr.flatMap(owners, ([version, parent], o) =>
			defined(counts[o]) === 0 ? [] : [{ version, parent, positions: BigInt(defined(counts[o])) }]
		)
	)
	const position = slot(closedId(Position), fin(Model, "positions"))
	/** The dependent sum's points, owner by owner, each block from-major: the cells in order. */
	const points = Arr.flatMap(owners, (owner, o) =>
		Arr.map(odometer([defined(counts[o]), defined(counts[o])]), ([from, to]) => ({
			owner,
			from: defined(from),
			to: defined(to)
		}))
	)
	const pos = (code: number) => defined((["p0", "p1", "p2"] as const)[code])
	const Follow = closed.relation(
		"Follow",
		{ version: closedId(Version), parent: closedId(Kind), from: position, to: position },
		["version", "parent", "from", "to"],
		Arr.flatMap(points, (p, at) =>
			at % 2 === 0
				? [{ version: p.owner[0], parent: p.owner[1], from: pos(p.from), to: pos(p.to) }]
				: []
		)
	)
	const owned = succeeded(
		ownedInput(schema("Tamper", { Version, Kind, Position, Model, Follow }, []))
	)
	const installation = succeeded(compileInstallation(owned, installOptions(owned, "owner")))
	const fn = installation.names.closed("Follow").function
	const rowsPack = defined(
		Arr.flatMap(installation.statements, (s) =>
			s.kind === "packConstant" && s.function.name === fn.name ? [s] : []
		)[0]
	)
	const constant = { cells: rowsPack.cells, width: rowsPack.width, entries: cellsOf(rowsPack) }
	const literal = statedAsLiteral(rowsPack)
	const printed = printStatement(literal)
	const form = literal.form.kind === "literal" ? literal.form : undefined

	it("holds when untampered, and refuses every one-bit change naming its relation, cell and key", () => {
		const parts = defined(form, "the literal form")
		assert.equal(literalPackFault(installation, printed), undefined)
		const bits = expanded(parts.hex, parts.tail)
		for (let at = 0; at < bits.length; at += 1) {
			const flipped = `${Str.slice(0, at)(bits)}${bits[at] === "1" ? "0" : "1"}${Str.slice(at + 1)(bits)}`
			const whole = Math.floor(flipped.length / 4) * 4
			const hex = Arr.join(
				Array.from({ length: whole / 4 }, (_, d) =>
					Str.toUpperCase(Number.parseInt(Str.slice(d * 4, d * 4 + 4)(flipped), 2).toString(16))
				),
				""
			)
			const tampered = pipe(
				printed,
				Str.replace(`X'${parts.hex}'`, `X'${hex}'`),
				Str.replace(`B'${parts.tail}'`, `B'${Str.slice(whole)(flipped)}'`)
			)
			const cell = Math.floor(at / constant.width)
			const point = defined(points[cell])
			assert.deepEqual(
				literalPackFault(installation, tampered),
				{
					kind: "content",
					function: printObjectName(fn),
					relation: "Follow",
					differs: {
						cell: BigInt(cell),
						key: [point.owner[0], point.owner[1], pos(point.from), pos(point.to)]
					}
				},
				`bit ${at} changed`
			)
		}
	})

	it("refuses a literal out of its form, a digit dropped or added, and a character no digit", () => {
		const parts = defined(form, "the literal form")
		assert.deepEqual(
			Arr.map(
				auditTextViolations(Str.replace(`X'${parts.hex}'::`, `(X'${parts.hex}')::`)(printed)),
				(v) => v.rule
			),
			["untypedLiteral"],
			"the structural audit admits a bit-string constant only cast"
		)
		assert.deepEqual(
			Arr.map(
				auditTextViolations(Str.replace(`X'${parts.hex}'::`, `E'${parts.hex}'::`)(printed)),
				(v) => v.rule
			),
			["untypedLiteral"],
			"and no other prefixed string, cast or not"
		)
		const bits = BigInt(parts.hex.length * 4 + parts.tail.length)
		assert.notEqual(parts.tail, "", "Follow's 14 cells of one bit end in a binary tail")
		assert.deepEqual(literalPackFault(installation, Str.replace("X'", "Y'")(printed)), {
			kind: "form"
		})
		assert.deepEqual(
			literalPackFault(installation, `${printed} || B'1'::bit varying`),
			{ kind: "form" },
			"a part past the literal's own"
		)
		for (let digits = 1; digits <= parts.hex.length + 3; digits += 1) {
			if (digits === parts.hex.length) {
				continue
			}
			const edited = Str.slice(0, digits)(`${parts.hex}000`)
			assert.deepEqual(
				literalPackFault(installation, Str.replace(`X'${parts.hex}'`, `X'${edited}'`)(printed)),
				{
					kind: "layout",
					function: printObjectName(fn),
					fault: {
						kind: "length",
						bits: BigInt(digits * 4 + parts.tail.length),
						expected: bits
					}
				},
				`${digits} hex digits`
			)
		}
		assert.deepEqual(
			literalPackFault(
				installation,
				Str.replace(`B'${parts.tail}'`, `B'2${Str.slice(1)(parts.tail)}'`)(printed)
			),
			{
				kind: "layout",
				function: printObjectName(fn),
				fault: { kind: "digit", at: parts.hex.length }
			},
			"a tail digit no binary one"
		)
		const foreign = literalPackFault(
			installation,
			Str.replace(`X'${parts.hex}'`, `X'G${Str.slice(1)(parts.hex)}'`)(printed)
		)
		assert.deepEqual(foreign, {
			kind: "layout",
			function: printObjectName(fn),
			fault: { kind: "digit", at: 0 }
		})
	})

	it("refuses a comment or a name edited away from its literal, and a row count not its cells", () => {
		const parts = defined(form, "the literal form")
		const first = defined(constant.entries[0], "Follow's first row")
		const other = { ...constant, entries: Arr.filter(constant.entries, (_, i) => i > 0) }
		const restated = literalOf(other)
		const comment = Str.replace(
			`content ${constantDigestOf(constant)}`,
			`content ${constantDigestOf(other)}`
		)
		assert.deepEqual(
			literalPackFault(installation, comment(printed)),
			{ kind: "content", function: printObjectName(fn), relation: "Follow", differs: undefined },
			"the comment's digest changed alone"
		)
		const point = defined(points[Number(first.index)])
		assert.deepEqual(
			literalPackFault(
				installation,
				pipe(
					printed,
					comment,
					Str.replace(`X'${parts.hex}'`, `X'${restated.hex}'`),
					Str.replace(`B'${parts.tail}'`, `B'${restated.tail}'`)
				)
			),
			{
				kind: "content",
				function: printObjectName(fn),
				relation: "Follow",
				differs: {
					cell: first.index,
					key: [point.owner[0], point.owner[1], pos(point.from), pos(point.to)]
				}
			},
			"the literal and its comment changed together, the name left digesting the drafted content"
		)
		const rows = constant.entries.length
		assert.deepEqual(
			literalPackFault(
				installation,
				Str.replace(`${rows} rows in `, `${rows + 1} rows in `)(printed)
			),
			{
				kind: "rows",
				function: printObjectName(fn),
				stated: BigInt(rows + 1),
				held: BigInt(rows)
			}
		)
	})

	it("drafts nothing for a pack its snapshot states in the other form, and refuses a literal its name does not digest", () => {
		const stated = literalInstallation(installation)
		const empty = emptySnapshot({ schemaName: "Tamper", schema: installation.names.schema })
		const draft = (previous: DeploySnapshot, target: Installation) =>
			draftMigration({
				previous,
				installation: target,
				workload: noWorkload,
				declared: { renames: [], drops: [] },
				abandoned: []
			})
		const forms = { rows: installation, literals: stated }
		for (const [before, previous] of Rec.toEntries(forms)) {
			for (const [after, target] of Rec.toEntries(forms)) {
				const why = `${before} restated as ${after}`
				const since = succeeded(draft(empty, previous), why).snapshot
				assert.deepEqual(succeeded(draft(since, target), why).folder.files, [], why)
			}
		}
		const asLiterals = succeeded(draft(empty, stated)).snapshot
		const object = defined(
			Arr.findFirst(asLiterals.manifest.objects, (o) =>
				Arr.some(o.ddl, (s) => s.kind === "packConstant" && s.function.name === fn.name)
			).pipe(Option.getOrUndefined),
			"Follow's constant in the snapshot"
		)
		const flipped: DeploySnapshot = {
			...asLiterals,
			manifest: {
				...asLiterals.manifest,
				objects: Arr.map(asLiterals.manifest.objects, (o) =>
					o.ident !== object.ident
						? o
						: {
								...o,
								ddl: Arr.map(o.ddl, (s) =>
									s.kind === "packConstant" && s.form.kind === "literal"
										? {
												...s,
												form: {
													...s.form,
													hex: firstBitFlipped(s.form.hex)
												}
											}
										: s
								)
							}
				)
			}
		}
		const reason = artifactRefusal(failed(draft(flipped, stated)))
		assert.deepEqual(
			[reason.artifact, reason.at, reason.what],
			["snapshot", ["objects", object.ident], "a constant whose name digests what it installs"]
		)
	})
})

describe("a declared pack", () => {
	const Kind = closed("Kind", ["k0", "k1", "k2"])
	const Flag = closed("Flag", ["f0", "f1"])
	const fields = { kind: closedId(Kind), flag: closedId(Flag) }
	const rows = [
		{ kind: "k0", flag: "f1" },
		{ kind: "k2", flag: "f0" }
	] as const
	const packs = ["rows", "hex"] as const

	/** What two closed relations of one content, A and B, declare: A's side is what a containment from Item reads. */
	interface Declared {
		readonly a: ClosedPack
		readonly b: ClosedPack
	}

	const declarations: Gen<Declared> = (s) => ({
		a: s.draw(element(packs)),
		b: s.draw(element(packs))
	})

	const compiled = (d: Declared) => {
		const A = closed.relation("A", fields, ["kind", "flag"], rows, { pack: d.a })
		const B = closed.relation("B", fields, ["kind", "flag"], rows, { pack: d.b })
		assert.deepEqual([A.pack, B.pack], [d.a, d.b], "each value states its declared pack")
		const Item = relation("Item", { id: uuid, kind: closedId(Kind) }, ["id"])
		const owned = succeeded(
			ownedInput(
				schema("Declared", { Kind, Flag, A, B, Item }, [contained(on(Item, "kind"), on(A, "kind"))])
			)
		)
		return succeeded(compileInstallation(owned, installOptions(owned, "owner")))
	}

	/** Each pack the installation installs, by its function, and its form. */
	const formsOf = (installation: Installation): ReadonlyMap<string, PackConstant["form"]["kind"]> =>
		new Map(
			Arr.flatMap(installation.statements, (s) =>
				s.kind === "packConstant" ? [[s.function.name, s.form.kind] as const] : []
			)
		)

	type Feature = "a shared constant as hex" | "a shared constant as rows" | "a side as hex"

	it.effect(
		"states a constant as hex where every relation that packs it declares hex, and a side as its relation declares",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/physical/literal-declared",
						oracle: {
							kind: "specification",
							name: "each pack's relations' declarations: hex where all of them declare hex"
						},
						box: "A and B of one content, each declared rows or hex, and A's side a containment reads",
						generator: declarations,
						literal: Formatter.format,
						limit: 4,
						coverage: requiredInSpace<Feature>([
							"a shared constant as hex",
							"a shared constant as rows",
							"a side as hex"
						]),
						caseHang
					},
					(d: Declared, c: Case<Feature>) =>
						Effect.sync(() => {
							const installation = compiled(d)
							const shared = installation.names.closed("A").function
							assert.equal(
								installation.names.closed("B").function.name,
								shared.name,
								"A and B pack one constant"
							)
							const forms = formsOf(installation)
							const both = d.a === "hex" && d.b === "hex"
							assert.equal(forms.get(shared.name), both ? "literal" : "rows", "the shared constant")
							const sides = Arr.filter([...forms], ([name]) => name !== shared.name)
							assert.ok(sides.length > 0, "A's side is a constant of its own")
							for (const [name, form] of sides) {
								assert.equal(form, d.a === "hex" ? "literal" : "rows", `the side ${name}`)
							}
							c.note(both ? "a shared constant as hex" : "a shared constant as rows")
							if (d.a === "hex") {
								c.note("a side as hex")
							}
						})
				)
			)
	)

	type Change = "a change of form" | "no change"

	it.effect("records a change of form in a folder of no file, installing nothing", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/physical/literal-redeclared",
					oracle: {
						kind: "specification",
						name: "content addressing: either form installs one constant, so a change of form replaces none"
					},
					box: "A and B declared rows or hex alike, then rows or hex alike",
					generator: (s) => ({ before: s.draw(element(packs)), after: s.draw(element(packs)) }),
					literal: Formatter.format,
					limit: 4,
					coverage: requiredInSpace<Change>(["a change of form", "no change"]),
					caseHang
				},
				(r: { readonly before: ClosedPack; readonly after: ClosedPack }, c: Case<Change>) =>
					Effect.sync(() => {
						const first = compiled({ a: r.before, b: r.before })
						const empty = emptySnapshot({ schemaName: "Declared", schema: first.names.schema })
						const draft = (previous: DeploySnapshot, target: Installation) =>
							succeeded(
								draftMigration({
									previous,
									installation: target,
									workload: noWorkload,
									declared: { renames: [], drops: [] },
									abandoned: []
								})
							)
						const target = compiled({ a: r.after, b: r.after })
						const next = draft(draft(empty, first).snapshot, target)
						assert.equal(next.change, r.before === r.after ? "none" : "schema")
						assert.deepEqual(next.folder.files, [], "no statement: every constant stands")
						const recorded = Arr.flatMap(next.snapshot.manifest.objects, (o) => o.ddl)
						assert.deepEqual(
							[...formsOf({ ...target, statements: recorded })],
							[...formsOf(target)],
							"the snapshot records the target's forms"
						)
						c.note(r.before === r.after ? "no change" : "a change of form")
					})
			)
		)
	)
})
