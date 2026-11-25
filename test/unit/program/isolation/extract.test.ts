/**
 * What a change member's statements read and write, as the isolation certifier reads them (program/isolation/extract.ts
 * memberFacts): every read with its mode, whether it is the call's own, the fields it is bound at and what binds them;
 * and every write with the positive reads that feed it.
 *
 * Each case draws a member of one to three statements over W, R and S, stored relations of fields id, a and b whose
 * tables also hold a column no field is (a law column), and X, a table no relation names, compiled for READ COMMITTED
 * or SERIALIZABLE: a SELECT; an INSERT with ON CONFLICT DO NOTHING, DO SELECT or DO UPDATE over drawn conflict columns,
 * ON CONSTRAINT, or DO NOTHING with no target, which a key of id and a UNIQUE over a and the law column arbitrate, its
 * source a query, a VALUES row, or one of the statement's query CTEs alone, an UPDATE, a DELETE (an INSERT's and a
 * DELETE's target may be a carrier), or a MERGE of up to three WHEN clauses; with
 * statement CTEs that read or write, the reading ones read where a source names them; or a statement no member sends. Each query is a core or a UNION, EXCEPT or INTERSECT of cores. A core reads tables,
 * carriers, CTEs, a writing CTE's RETURNING, relation inputs' arrays, VALUES, a function's rows, the session's context,
 * derived tables, among them ones of the context's fact alone or beside VALUES, a probe of a table at a key, a group or a
 * group's last row, an INSERT's met rows (a writing CTE's INSERT and a query CTE), itself or through a MATERIALIZED query
 * CTE that holds them whole, and the row an arbitration met for the met rows of an own source it sees, joined in one
 * chain or crosswise,
 * under a WHERE
 * and ON conjuncts that equate a table's columns with a placeholder, an own source's column of its core or an enclosing
 * one, another table's column, a literal or a cast placeholder; it filters by EXISTS, NOT EXISTS, IN, NOT IN, NOT and
 * calls of schema functions, nested; it counts by GROUP BY, HAVING, count(*), an aggregate call, ordered-set ones among
 * them, an aggregate inside COALESCE, or a window call; and it projects a scalar subquery, an ARRAY or an EXISTS.
 *
 * Oracle: the extractor's contract restated over the drawn shape, never over the built statements.
 * - A read's polarity: NOT flips it, an EXCEPT arm after the first flips it, EXISTS and IN keep it and their NOT flips
 *   it in a condition, and in a value either is either way, `both`. Counted beneath a counting core (a GROUP BY, a
 *   HAVING, a call over many rows, an aggregate's or a window's), a scalar subquery and an ARRAY. Probe on the table
 *   sources of an EXISTS's own cores alone.
 * - A read's mode: arbiter for a probe of a relation its statement writes, an ON CONFLICT, one per object an ON
 *   CONFLICT with no target arbitrates, a MERGE's NOT MATCHED where it writes, and the row an arbitration met wherever
 *   it stands where its met rows, read themselves or through a query CTE that holds them whole, are a writing CTE's
 *   INSERT into its table that proposes their query CTE alone and
 *   skips by DO NOTHING with no target or over columns among its key; else negated where not positive; else counted
 *   where counted; else positive. A probe reads its table bound by its own equalities, the row met by its key bound to
 *   its met rows' column, alone; a probe is a row source of its core, the row met none, and met rows read their query
 *   CTE where they stand. Compiled for READ COMMITTED, the row met is `?met:"schema"."name"` and an ON CONFLICT with no
 *   target `?every:"schema"."name"`, each negated, in place of their reads.
 * - A carrier read is the call's own, of no group; a table no relation names is `?"schema"."name"`, a schema function
 *   the names do not clear `?function:"schema"."name"`, negated, and a statement no member sends `?statement:<kind>`, each object named as SQL quotes it, which no two names share.
 * - A table's group is the fields of its columns its core's conditions (its WHERE and every ON of its FROM; a MERGE's
 *   ON and its clause's condition as the clause reads it) equate with a placeholder or a column of an own source in
 *   scope, its core's or an enclosing core's (a non-LATERAL derived table and a CTE see none of their reader's), else,
 *   by its first such equality, with another table's column of its core, the field of the row that table's read finds
 *   (none where that column is no field), the field-less column dropped, sorted; its binding is what binds each in that
 *   order (facts.ts bindingText; a stored row's field by the relation of the read that finds it), one group for the
 *   call where each but the stored rows' is a placeholder, the context's claim or a derived table of one row of it (one
 *   core over such sources alone, filtering, counting and projecting nothing beyond its column), else one per row. An
 *   ON CONFLICT's group is its conflict columns', each bound to EXCLUDED's. A table read through a derived table that only renames its columns (each named
 *   as the table's, each the rotation's other) is keyed so by the conditions of the core that reads it, through the
 *   renaming, the derived table an outside table's value; one that also takes a LIMIT is keyed by none of them, read as
 *   its own query's, the derived table the call's own rows, so its own equalities equate it with no other table.
 * - A query CTE is read where a source names it, with that source's polarity, count and writes; a writing CTE runs
 *   once, and a source naming it reads its RETURNING, the call's own rows, which are no read and no row source.
 * - A write's `from` is the positive reads that feed it: its source's, an UPDATE's and a DELETE's target and FROM, a
 *   MERGE's source and every target read; a DO UPDATE writes its table twice from them.
 * - Every flip of polarity and every count opens a probe gating the writes its place feeds, judged by a grouped core's
 *   own rows where that core opens it, else by the core it stands in. A core's row sources are its sources in FROM
 *   order, an UPDATE's or a DELETE's target first: a table's read, a probe's, a renaming projection's read, a LIMIT's
 *   or a stacked projection's core, a derived table's or a CTE's query by its one core or a UNION's arms; none for an
 *   INTERSECT, an EXCEPT or another source, and none at all for a core counting with no GROUP BY.
 * Reads are compared as multisets, the arbitrations after every other read, writes by the reads their `from` names, and
 * probes by the writes they gate and their core's row sources, each read marked where it stands beneath other probes
 * than the probe's chain. Each statement's facts are compared through their expansion (test/support/expanded.ts): the
 * extractor walks each query CTE once per arrival, an instance its sources use, and the expansion reads each instance
 * again at each use, which is what the contract above restates. The instances walk one query for each query CTE a
 * source reads, and the instances of one query read alike, their modes apart (CteFacts.query).
 *
 * Planted in a scratch copy of the extractor, each of these fails the search: NOT EXISTS read as positive, an
 * aggregate's scan read as positive, a probe of the written relation read as negated, a table no relation names dropped
 * instead of named, a projection's renaming dropped, a derived table's conditions stopped at one level, placeholders'
 * declared names dropped, an ON CONFLICT's parameters dropped, probes never opened, every counting core's probe judged
 * by its own rows, grouped or not, a UNION passing no rows, a UNION through one arm alone, an INTERSECT or an EXCEPT as
 * a UNION, an ungrouped aggregate's sources as its row sources, an expression's subquery as a row source of the core it
 * stands in, a derived table's or a CTE's rows as no row source; and the row met sealed with no met rows in scope,
 * through an INSERT into another relation, an INSERT reading anything but its proposed CTE alone, or met rows of another
 * CTE than it proposes, under DO SELECT or DO UPDATE, or over conflict columns its key only meets; the row met or an ON
 * CONFLICT with no target read as an arbitration at READ COMMITTED; the row met as a row source, a probe as none, met
 * rows that skip their proposed CTE, an ON CONFLICT with no target arbitrating one object alone, and a probe's
 * equalities dropped.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { memberFacts } from "#compiler/program/isolation/extract.ts"
import { expanded } from "#test/support/expanded.ts"
import {
	buildStatement,
	caseGen,
	type Expected,
	expected,
	expectedOf,
	gotRows,
	NAMES,
	probeRows,
	readKey,
	type Shape,
	slotFill,
	sortedKeys,
	writeKey
} from "#test/unit/program/isolation/extract.fixtures.ts"

/** A change member's facts name every read by its mode, its own, its group and its binding, and every write by the positive reads that feed it, as the contract restated over the drawn statements says. Its budget is its suite's before it was a property (test/unit/program/isolation/extract.test.ts at 4ca3036a): 500 runs and 500 steered cases. */
export const aChangeMembersFactsNameEveryReadByItsModeItsOwnItsGroupAndItsBindingAndEveryWriteByThePositiveReadsThatFeedItAsTheContractRestatedOverTheDrawnStatementsSays =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 500, steered: 500 },
		situations: [
			"a positive read",
			"a negated read",
			"a counted read",
			"an arbiter read",
			"a read either way",
			"a carrier read",
			"a read no relation names",
			"a group bound by a placeholder",
			"a group bound by an own column",
			"a group bound by an enclosing core's column",
			"a law column dropped from a group",
			"a write's positive reads",
			"a MERGE",
			"a MERGE's NOT MATCHED arbiter",
			"a CTE read where it is named",
			"a CTE's write",
			"an EXCEPT arm",
			"NOT flipped back",
			"an aggregate inside COALESCE",
			"a HAVING",
			"an ordered-set aggregate",
			"a window call",
			"a function that may read tables",
			"an ON CONFLICT arbiter over its conflict columns",
			"a DO UPDATE",
			"a target bound by its WHERE",
			"a statement no member sends",
			"a projection keyed by the conditions of the core that reads it",
			"a projection outside conditions do not key",
			"an ON CONFLICT bound by the parameters its row carries",
			"a group keyed through two derived tables",
			"a grouped count judged by its own rows",
			"an ungrouped count judged by the core its value lands in",
			"a probed core reading a one-core derived table or CTE",
			"a probed core reading a UNION",
			"a probed core reading an INTERSECT or an EXCEPT",
			"a probed core reading an aggregate with no GROUP BY",
			"a probed core reading a probe",
			"an ON CONFLICT with no target, arbitrating every key and UNIQUE",
			"a probe at a key",
			"a probe at a group",
			"the row an arbitration met",
			"the row an arbitration met, refused at READ COMMITTED",
			"an ON CONFLICT with no target, refused at READ COMMITTED",
			"a writing CTE's RETURNING read as the call's own rows",
			"the row met through no met rows, read by its place",
			"the row met through met rows of no INSERT proposing them alone with DO NOTHING over its key, read by its place",
			"an INSERT's met rows",
			"an INSERT proposing a query CTE alone",
			"a probe at a group's last row",
			"a group bound by the context's fact",
			"a CTE that holds an INSERT's met rows whole",
			"the row an arbitration met, through a CTE that holds its met rows whole",
			"a group bound by a derived table of the context's fact, one value",
			"a group bound by a derived table of the context's fact and VALUES, one per row",
			"a group bound by a column its own source's query fixes",
			"a group bound by the row another table's read finds"
		] satisfies ReadonlyArray<Reached<Shape>>,
		check: (_2, k: Case<Shape>) => (c) =>
			Effect.sync(() => {
				const facts = memberFacts(
					"member",
					Arr.map(c.statements, buildStatement),
					NAMES,
					(_, n) => slotFill(n),
					c.level
				)
				assert.equal(
					facts.statements.length,
					c.statements.length,
					"one statement's facts per statement"
				)
				Arr.forEach(c.statements, (spec, i) => {
					const shared = Arr.getUnsafe(facts.statements, i)
					const got = expanded(shared)
					/** A flat read as the comparison reads it, among the reads of the body it stands in. */
					const gotOf = (at: number): Expected => {
						const origin = Arr.getUnsafe(got.origins, at)
						const body = origin.cte === undefined ? shared : Arr.getUnsafe(shared.ctes, origin.cte)
						return expectedOf(Arr.getUnsafe(body.reads, origin.read), body.reads)
					}
					const gotReads = Arr.map(got.reads, (_, at) => gotOf(at))
					const x = expected(spec, c.level)
					assert.equal(
						new Set(Arr.map(shared.ctes, (cte) => cte.query)).size,
						x.ctes.size,
						`statement ${i}'s instances walk one query for each query CTE a source reads`
					)
					const shapes = new Map<number, string>()
					for (const cte of shared.ctes) {
						const shape = Arr.join(
							Arr.map(cte.reads, (r) => readKey({ ...expectedOf(r, cte.reads), mode: "positive" })),
							";"
						)
						assert.equal(
							shapes.get(cte.query) ?? shape,
							shape,
							`statement ${i}'s instances of one query read alike`
						)
						shapes.set(cte.query, shape)
					}
					for (const shape of x.shapes) {
						k.note(shape)
					}
					assert.deepEqual(
						sortedKeys(gotReads),
						sortedKeys([...x.reads, ...x.tail]),
						`statement ${i}'s reads`
					)
					assert.deepEqual(
						sortedKeys(Arr.takeRight(gotReads, x.tail.length)),
						sortedKeys(x.tail),
						`statement ${i}'s ON CONFLICT arbitrations follow every other read`
					)
					assert.deepEqual(
						Arr.sort(
							Arr.map(got.reads, (r, at) => `${readKey(gotOf(at))}|${r.base}|${r.probes.length}`),
							Order.String
						),
						Arr.sort(
							[...x.based, ...Arr.map(x.tail, (r) => `${readKey(r)}|arbiter|0`)],
							Order.String
						),
						`statement ${i}'s reads' base modes and the probes above them`
					)
					const gateKey = (
						gates: ReadonlyArray<number>,
						writes: ReadonlyArray<{ readonly relation: string; readonly op: string }>
					): string =>
						Arr.join(
							Arr.sort(
								Arr.map(gates, (g) => {
									const w = Arr.getUnsafe(writes, g)
									return `${w.relation}|${w.op}`
								}),
								Order.String
							),
							","
						)
					const gotCores = Arr.map(got.cores, (sources) => gotRows(got.reads, gotOf, sources))
					assert.deepEqual(
						Arr.sort(
							Arr.map(
								got.probes,
								(p) => `${gateKey(p.gates, got.writes)}|${probeRows(gotCores, p.core, p.chain)}`
							),
							Order.String
						),
						Arr.sort(
							Arr.map(
								x.probes,
								(p) => `${gateKey(p.gates, x.writes)}|${probeRows(x.cores, p.core, p.chain)}`
							),
							Order.String
						),
						`statement ${i}'s probes, each by the writes it gates and the row sources of its core`
					)
					const gotWrites = Arr.map(got.writes, (w) =>
						writeKey(
							w.relation,
							w.op,
							Arr.map(w.from, (at) => {
								const read = Arr.getUnsafe(got.reads, at)
								assert.equal(
									read.mode,
									"positive",
									`statement ${i}'s write of ${w.relation} names a positive read`
								)
								return gotOf(at)
							})
						)
					)
					const wantWrites = Arr.map(x.writes, (w, at) =>
						writeKey(
							w.relation,
							w.op,
							Arr.filter(x.reads, (r) => r.mode === "positive" && r.feeds.includes(at))
						)
					)
					assert.deepEqual(
						Arr.sort(gotWrites, Order.String),
						Arr.sort(wantWrites, Order.String),
						`statement ${i}'s writes`
					)
					if (
						Arr.some(x.writes, (_, at) =>
							Arr.some(x.reads, (r) => r.mode === "positive" && r.feeds.includes(at))
						)
					) {
						k.note("a write's positive reads")
					}
				})
			}),
		oracle: {
			kind: "specification",
			name: "the extractor's contract restated over the drawn statements: each read's mode from its place, its group and binding from its conditions, each write's positive reads"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/program/isolation/extract.test.ts#aChangeMembersFactsNameEveryReadByItsModeItsOwnItsGroupAndItsBindingAndEveryWriteByThePositiveReadsThatFeedItAsTheContractRestatedOverTheDrawnStatementsSays:-:0.1.2.0.1.5.0.0.0.1.0.2.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.1.0.2.0.0.3.0.3.1.0.0.0.0.0.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"a read of W keyed by :a whose c_hidden, a law column of no field, and c_a equal another read's column: the model took the c_hidden equality as the binding and dropped the next, where the extractor skips an equality that binds nothing (SUBMITKEY's rotating stream, TEST_SEED 0xc818218f case 410)",
				since: "2026-11-25"
			}
		],
		kills: [
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					'\t\t\treturn named.bound.get(column) ?? { kind: "own", alias: table, column, rows: named.rows }\n',
				replacement: '\t\t\treturn { kind: "own", alias: table, column, rows: named.rows }\n',
				why: "A column of an own source read as one value per row whatever its query fixes, as extract.ts read it: a read joined on a relation parameter's column its query fixes to a parameter binds one group per row, unsealed (edullm's QTIAPP-LEARNER: the ledger's `sittings`, a TestSession query at child = :child, left every read joined on it of no one group)."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					"\t\t\t\t\t\tname === undefined ? undefined : (once(name) ?? carried(name) ?? learned(name))\n",
				replacement: "\t\t\t\t\t\tundefined\n",
				why: "A query's target fixed only where it is a parameter or a fixed column itself, never through its conditions' equalities: a target the WHERE equates with a parameter, the relation parameter's own key column, fixes nothing."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					"\t\tif (held !== undefined) {\n\t\t\treturn [source.alias ?? source.name, held]\n\t\t}\n",
				replacement: "",
				why: "A query CTE that holds an INSERT's met rows whole read as any CTE's rows, as extract.ts read it: the row met through it, which the SERIALIZABLE insert protocol reads (write/insert/protocol.ts classifyMet), is read by its place, unsealed, so every SERIALIZABLE inserter is a pivot of what it inserts (METIS-ROLES's roles-mini, admin) and keeps every reader of it SERIALIZABLE by `writers`."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original: '\tif (!sources.every(({ source }) => nameOf(source)[1] === "one")) {',
				replacement: "\tif (sources.length < 0) {",
				why: "A derived table over the context's fact and many rows read as one row, so a read bound to its column binds one group where it reads one per row."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original: `\t\t\t\tthis.#opaque(\`?every:\${printObjectName(table)}\`, c)`,
				replacement: `\t\t\t\tthis.#opaque(\`?every:\${table.schema}.\${table.name}\`, c)`,
				why: 'An ON CONFLICT with no target read at READ COMMITTED named by its table\'s dotted text, `?every:<schema>.<name>`, as extract.ts spelled it, which "a.b"."c" and "a"."b.c" share; the read is not the one the contract names.'
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					"\t\t\tthis.query(e.query, this.#entering(c, { ...c, probe: true, polarity: predicate(c, e.not) }))",
				replacement:
					"\t\t\tthis.query(e.query, this.#entering(c, { ...c, probe: true, polarity: predicate(c, false) }))",
				why: "NOT EXISTS is read as positive."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					'\t\t\t\top.op === "EXCEPT" && i > 0 ? this.#entering(c, { ...c, polarity: flipped(c.polarity) }) : c',
				replacement: '\t\t\t\top.op === "EXCEPT" && i > 0 ? this.#entering(c, { ...c }) : c',
				why: "An EXCEPT arm after the first keeps its polarity, unflipped."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original: "\t\tconst key: InstanceKey = [cte, polarity, counted, ...feeds]",
				replacement: '\t\tconst key: InstanceKey = [cte, "positive", counted, ...feeds]',
				why: "A query CTE's instance is keyed as positive whatever its polarity, so a negated or both-way read of it finds the positive instance's walk; a statement's reads fail."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original: "\t\tconst key: InstanceKey = [cte, polarity, counted, ...feeds]",
				replacement: "\t\tconst key: InstanceKey = [cte, polarity, counted]",
				why: "A query CTE's instance is keyed without the writes its site feeds, so a read feeding other writes finds an instance walked for none of them; a statement's writes fail."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					"\t\tconst query = this.#queries.getOrInsertComputed(cte.query, () => this.#queries.size)",
				replacement: "\t\tconst query = this.instances.length",
				why: "Every instance of a query CTE walks a query of its own, numbered by the instances, so two instances of one query are no longer read as one query; the check that the instances walk one query for each query CTE a source reads fails."
			},
			{
				file: "packages/engine/src/program/isolation/extract.ts",
				original:
					"\t\tconst query = this.#queries.getOrInsertComputed(cte.query, () => this.#queries.size)",
				replacement: "\t\tconst query = this.#queries.size > 0 ? 0 : this.#queries.size",
				why: "Every query CTE after the first takes the first's query, so the instances of different queries read as one query; the same check fails."
			}
		]
	})
