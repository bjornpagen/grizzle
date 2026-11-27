import { assert } from "@bjornpagen/testing/assert"
/**
 * A missed index is an internal compiler error (packages/engine/src/physical/access/seeks.ts, each statement read into
 * its seek program by packages/engine/src/sql/seeks.ts): every read a statement makes of a stored table at values its
 * scope fixes is a seek some index of the table serves, the bound O(k log n) of a keyed read, where one no index leads
 * with reads the whole table. The installation holds every statement it installs to it, a judge's and an upkeep's
 * among them, and generate every read and write a login's served file sends.
 *
 * Property: over drawn tables (two to four columns, each of many values, some of a leaky equality, of few or of none a
 * B-tree holds), up to three indexes over them in a drawn order, B-trees unique or not and GiST ones, and a read binding a drawn set of
 * columns at literals, at the columns of a row before it read LATERAL, through a DISTINCT derived table PostgreSQL
 * pushes the equality into, at the columns of a table its key binds at a literal, at the columns of a table no index
 * binds, a join, at an uncorrelated sub-link's array, through a plain view, through a security barrier, at the
 * columns of a keyed table read through its view at its key, or over a CTE of the table, NOT MATERIALIZED, which
 * PostgreSQL inlines into its reader, or MATERIALIZED, read once, whole, the check refuses the read exactly where the
 * specification says no index serves it.
 *
 * Oracle: the specification (seeks.fixtures.ts `missed`): a seek is served where it binds no column of many values, or
 * some index's leading run holds every one it binds, or holds a unique index whole, or it binds a GiST index's first
 * column, a column of few values a filter beside the run; a join binds nothing, and a barrier passes no leaky equality.
 *
 * Kills: a leading run serving part of the binding; an index's columns read in any order; the one-row closure dropped;
 * the push into a derived table dropped; a column of an outer row read as one of the level's; the columns of few values
 * judged as many; an uncorrelated sub-link read as a join; a view read as no relation; a leaky equality pushed past a
 * barrier; a view read at its key read as many rows; a NOT MATERIALIZED CTE read where it stands; a MATERIALIZED one
 * read as inlined.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, String as Str } from "effect"
import { judgeSeeks } from "#compiler/physical/access/seeks.ts"
import { seekProgram } from "#compiler/sql/seeks.ts"
import {
	featuresOf,
	missed,
	type SeekFeature,
	seekSpace,
	statementOf,
	tablesOf
} from "#test/unit/physical/seeks.fixtures.ts"

/** The check refuses a drawn read exactly where no index of its table serves its binding. */
export const theCheckRefusesExactlyTheReadsNoIndexServes = property.explore(seekSpace, {
	needs: {},
	situations: [
		"a missed seek",
		"a seek an index's leading run serves",
		"a seek a unique index serves whole",
		"a seek of columns of few values alone no index serves",
		"a seek an index holds out of order",
		"direct",
		"lateral",
		"pushed",
		"oneRow",
		"joined",
		"sublink",
		"view",
		"barrier",
		"viewOneRow",
		"a barrier holding out a leaky equality the verdict turns on",
		"a missed seek at an uncorrelated sub-link",
		"a missed seek through a view",
		"a missed seek at the row a view reads by its key",
		"inlinedCte",
		"materializedCte",
		"a missed seek through a NOT MATERIALIZED CTE",
		"a seek a MATERIALIZED CTE holds out",
		"a seek a GiST index serves at its first column alone"
	] satisfies ReadonlyArray<Reached<SeekFeature>>,
	check: (_, c: Case<SeekFeature>) => (drawn) =>
		Effect.sync(() => {
			const refused = (() => {
				try {
					judgeSeeks(seekProgram([statementOf(drawn)]), tablesOf(drawn), "the drawn read")
					return false
				} catch (e) {
					assert.ok(
						Str.includes("missed index")(String(e)),
						`${Formatter.format(drawn)}: the check refuses as a missed index alone: ${String(e)}`
					)
					return true
				}
			})()
			assert.equal(
				refused,
				missed(drawn),
				`${Formatter.format(drawn)}: the check ${refused ? "refuses" : "admits"} the read`
			)
			for (const f of featuresOf(drawn)) {
				c.note(f)
			}
		}),
	oracle: {
		kind: "specification",
		name: "a seek no index's leading run serves, beside columns of few values and none a B-tree holds, and none a join binds or a barrier holds out"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/physical/access/seeks.ts",
			original: "\t\t\t(i.gist && run.length > 0) ||\n",
			replacement: "",
			why: "A GiST index is read as a B-tree, through its leading run alone: a seek binding its first column, a span at a value, and a scalar it holds later is refused, where PostgreSQL scans the index at its first column's condition (served-live's role0read2, Rel0x0 at (fixed_0, span_40) beside an index (span_40, tick_0, fixed_0))."
		},
		{
			file: "packages/engine/src/sql/seeks.ts",
			original: "\t\t\t\t\t\tinlined === undefined\n",
			replacement: "\t\t\t\t\t\tinlined === undefined || true\n",
			why: "A NOT MATERIALIZED CTE is read where it stands, at no reader's binding, though PostgreSQL inlines it into its reader: a read of it at a value seeks its table at nothing, and a missed seek through it is admitted (served-live's role0read0, a CTE of Rel0x0 read at bool = 0 and at bool = 1)."
		},
		{
			file: "packages/engine/src/sql/seeks.ts",
			original: '\t\t\t\t\t\tc.materialized === "NOT MATERIALIZED" && c.query.kind === "select"\n',
			replacement: '\t\t\t\t\t\tc.materialized !== undefined && c.query.kind === "select"\n',
			why: "A MATERIALIZED CTE is read as inlined into its reader: its query, which PostgreSQL derives once, whole, is judged at the reader's binding, and a read the CTE holds out of its table is refused as a missed seek it never makes."
		},
		{
			file: "packages/engine/src/physical/access/seeks.ts",
			original: "\t\t\theld.every((c) => run.includes(c))\n",
			replacement: "\t\t\theld.some((c) => run.includes(c))\n",
			why: "A leading run serving part of the binding serves it: an index on the learner serves a read of the learner's attempt at its number, every attempt of the learner read."
		},
		{
			file: "packages/engine/src/physical/access/seeks.ts",
			original: "\t\tif (!bound.has(c)) {\n\t\t\tbreak\n\t\t}\n",
			replacement: "\t\tif (!bound.has(c)) {\n\t\t\tcontinue\n\t\t}\n",
			why: "An index's columns read in any order: an index on (child, item, n) serves a read at n, which PostgreSQL reads only by stepping every child and item."
		},
		{
			file: "packages/engine/src/sql/seeks.ts",
			original: '\t\t\tif (i.kind === "stored" && !single.has(at) && oneRow(i.table, at)) {\n',
			replacement: "\t\t\tif (false) {\n",
			why: "No item of a level reads one row by its key: a seek at the columns of a row its key binds is a join the check judges nothing of, as a judge's probe at its delta's row is."
		},
		{
			file: "packages/engine/src/sql/seeks.ts",
			original: "\t\t\t\t\tpartitioned(refKey(c.table, c.column))\n",
			replacement: "\t\t\t\t\tfalse\n",
			why: "No equality over a derived table reaches its core: a read of a DISTINCT derivation at a value seeks its table at nothing."
		},
		{
			file: "packages/engine/src/sql/seeks.ts",
			original: "\t\t\tif (x.table !== undefined && aliases.has(x.table)) {\n",
			replacement: "\t\t\tif (x.table !== undefined) {\n",
			why: "A column of an outer row is read as one of the level's: a LATERAL seek at the row before it binds nothing, as a chain step's seek at the steps before it would."
		},
		{
			file: "packages/engine/src/physical/access/seeks.ts",
			original: '\tconst held = [...bound].filter((c) => table.holds.get(c) === "many")\n',
			replacement: '\tconst held = [...bound].filter((c) => table.holds.get(c) !== "none")\n',
			why: "A column of few values needs an index's run as one of many values does: a read of a roster's handle at its value, which picks a share of the table no index bounds, is refused, and a judge's probe at a member's coordinates beside a boolean lands on no index of the coordinates alone."
		},
		{
			file: "packages/engine/src/sql/seeks.ts",
			original: "\t\t\tcorrelated(x.query, aliases)\n",
			replacement: "\t\t\ttrue\n",
			why: "Every sub-link reads every item of its level: a write's restriction to the keys of the rows it holds, k = ANY (ARRAY(SELECT ...)), binds nothing, and the seek of the table it writes is judged at nothing."
		},
		{
			file: "packages/engine/src/physical/access/seeks.ts",
			original: "\tview: (key) => targets.views.get(key),\n",
			replacement: "\tview: () => undefined,\n",
			why: "No view is read as the derived table PostgreSQL expands it into: a role reads every relation through its view, so every read and write a login serves is judged at nothing."
		},
		{
			file: "packages/engine/src/sql/seeks.ts",
			original:
				"\tview.barrier ? new Set([...names].filter((n) => !queryLeaks(view.query, n, reading))) : names\n",
			replacement: "\tnames\n",
			why: "A leaky equality is read as pushed past a security barrier: a query entry's view read at a numeric is judged at a binding PostgreSQL never pushes into it."
		},
		{
			file: "packages/engine/src/sql/seeks.ts",
			original: "\treturn core.level.items.every((_, at) => single.has(at))\n",
			replacement: "\treturn false\n",
			why: "No view reads one row: a whole view read at its key fixes no column of the row it reads, and a table joined at those columns is judged at nothing."
		}
	]
})
