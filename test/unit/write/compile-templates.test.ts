/**
 * A write's compile writes each node's and expression's template once (ir/dag-digest.ts DagTemplates,
 * write/program/compile.ts compileAt): a template is a function of its node alone, and every key and digest of the
 * compile reads it from the compile's one store, its share planning's keys (ShareKeys), its lowering's evaluation keys
 * (lower/conservative/call/keys.ts EvaluationKeys) and attachment share keys (lower/shapes/share/index.ts shareKey), and
 * its read-backs' digests (write/readback/lower.ts QueryDigest) and lowerings, where each held a store of its own and
 * wrote the template again. On edullm's qti at hub 98230c3b6 the changes phase spent 118 s of 483 s sampled writing
 * templates, 213,278 of the first 400,000 a template written before; at e9e32a69c its write compiles, before
 * certification, took 567 s of CPU, and 436 s with one store a compile.
 *
 * The box, exhausted: a write of one member and of eight reading one call of eight bound imports, a chain of eight
 * levels of bound queries and eight readers of a take bound to a variable (shared-imports.fixtures.ts); and a
 * read-back's write (readback-placement.fixtures.ts) compiled over a subject of its own, keeping its read-back's program,
 * and compiled again over one subject, the second compile taking the program the first kept, comparing their queries'
 * digests.
 *
 * Property, per case: the templates the compile writes (calls of nodeTemplateOf and exprTemplateOf, counted by V8,
 * test/support/kernel/calls.ts) are the nodes and expressions whose templates it reads, each counted once whichever
 * store reads it (DagTemplates `node` and `expr`, observed for the compile). Oracle: specification, one template written
 * per distinct node and expression a compile reads. Kill: the write's lowering and its read-backs' read stores of their
 * own, so a node the share planning's keys read is written again by an evaluation key or a read-back's digest.
 *
 * And no store outlives its compile: the stores alive once the write is compiled, the compiled write and its subject
 * held, are those alive before it (node:v8 queryObjects over DagTemplates, after a full collection), so a compile's
 * templates, one for every node any key of it reached, go with it, where a kept read-back's program, kept for as long
 * as its subject's names (write/readback/lower.ts lowered), would hold them for the generate's life. Kill: a kept
 * read-back's query holds the templates of the compile that kept it.
 *
 * Features: an evaluation key digested, a read-back's query digested, a node the share planning keyed, a read-back's
 * program kept.
 */

import { queryObjects } from "node:v8"
import { assert } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import { compileWrite } from "#compiler/write/program/compile.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	type FixtureSchema,
	realityWrite,
	testArtifacts,
	testCompile
} from "#test/support/compile.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { checking } from "#test/support/policy.ts"
import { descOf } from "#test/unit/write/changeset/fixtures.ts"
import {
	compiledSketch,
	freshSubject,
	type Sketch
} from "#test/unit/write/readback-placement.fixtures.ts"
import {
	boundTakeWriteOf,
	chainWriteOf,
	readersOf,
	Shared
} from "#test/unit/write/shared-imports.fixtures.ts"

type Feature =
	| "an evaluation key digested"
	| "a read-back's query digested"
	| "a node the share planning keyed"
	| "a read-back's program kept"

/** A case's write: the shared-imports writes over Shared, or a read-back's write. */
type Shape =
	| "one reader of a call"
	| "eight readers of a call"
	| "a chain of eight levels"
	| "eight readers of a bound take"
	| "a read-back compiled first"
	| "a read-back compiled again"

/** A read-back of M's insertion's added side, riding the insertion. */
const readBack: Sketch = {
	op: "insert",
	beside: false,
	again: false,
	sides: "added",
	other: "A",
	written: "none",
	reads: "nothing"
}

/**
 * A case's compile, run where its templates are counted: the write's, or a read-back's first or second over one subject,
 * whose value holds the subject, under whose names its read-backs' programs are kept.
 */
const compileOf = (shape: Shape): { readonly compile: () => unknown } => {
	const over = (schema: FixtureSchema, change: unknown) => {
		const reality = realityWrite(succeeded(testArtifacts(schema, testCompile)))
		const desc = descOf(change)
		return { compile: () => succeeded(compileWrite(checking(schema), desc, reality)) }
	}
	switch (shape) {
		case "one reader of a call":
			return over(Shared, readersOf(1))
		case "eight readers of a call":
			return over(Shared, readersOf(8))
		case "a chain of eight levels":
			return over(Shared, chainWriteOf(8))
		case "eight readers of a bound take":
			return over(Shared, boundTakeWriteOf(8))
		case "a read-back compiled first": {
			const at = freshSubject()
			return { compile: () => [succeeded(compiledSketch(readBack, at)), at] }
		}
		case "a read-back compiled again": {
			const at = freshSubject()
			succeeded(compiledSketch(readBack, at))
			return { compile: () => [succeeded(compiledSketch(readBack, at)), at] }
		}
	}
}

const digests = "packages/engine/src/ir/dag-digest.ts"

/** The template stores alive, counted by V8 after a full collection. */
const storesAlive = (): number => queryObjects(DagTemplates, { format: "count" })

/**
 * The reads of a store's `name` method observed into `read`, each read's node or expression, until the returned
 * restoration: the method replaced on DagTemplates' prototype by one adding its argument and calling it.
 */
const observed = (name: "node" | "expr", read: Set<object>): (() => void) => {
	const original: unknown = Reflect.get(DagTemplates.prototype, name)
	if (typeof original !== "function") {
		throw new TypeError(`DagTemplates' ${name} is a method`)
	}
	Reflect.set(DagTemplates.prototype, name, function (this: DagTemplates, part: object): unknown {
		read.add(part)
		const template: unknown = Reflect.apply(original, this, [part])
		return template
	})
	return () => {
		Reflect.set(DagTemplates.prototype, name, original)
	}
}

/**
 * The templates `compile` writes, and the nodes and expressions whose templates it reads from any store, each once: the
 * stores' reads observed while it runs (DagTemplates `node` and `expr`), and restored after; with its value.
 */
const templatesOf = (compile: () => unknown) =>
	Effect.acquireUseRelease(
		Effect.sync(() => {
			const read = new Set<object>()
			return { read, restore: [observed("node", read), observed("expr", read)] }
		}),
		({ read }) =>
			Effect.map(
				callCounts(Effect.sync(compile), {
					nodes: { file: digests, name: "nodeTemplateOf" },
					exprs: { file: digests, name: "exprTemplateOf" },
					evaluations: {
						file: "packages/engine/src/lower/conservative/call/keys.ts",
						name: "evaluationDigest"
					},
					queries: { file: "packages/engine/src/write/readback/lower.ts", name: "equals" },
					kept: { file: "packages/engine/src/write/readback/lower.ts", name: "loweredAfresh" },
					shares: { file: digests, name: "key" }
				}),
				([value, counts]) => ({
					value,
					written: counts.nodes + counts.exprs,
					read: read.size,
					counts
				})
			),
		({ restore }) =>
			Effect.sync(() => {
				for (const undo of restore) {
					undo()
				}
			})
	)

/** A write's compile writes each node's and expression's template once, whichever of its keys and digests reads it. */
export const aWritesCompileWritesEachNodesAndExpressionsTemplateOnceWhicheverOfItsKeysAndDigestsReadsIt =
	property.exhaust(
		finite((source) =>
			source.draw(
				element<Shape>([
					"one reader of a call",
					"eight readers of a call",
					"a chain of eight levels",
					"eight readers of a bound take",
					"a read-back compiled first",
					"a read-back compiled again"
				])
			)
		),
		{
			needs: {},
			situations: [
				"an evaluation key digested",
				"a read-back's query digested",
				"a node the share planning keyed",
				"a read-back's program kept"
			],
			check: (_, k: Case<Feature>) => (shape) =>
				Effect.gen(function* () {
					const { compile } = compileOf(shape)
					const before = storesAlive()
					const { value, written, read, counts } = yield* templatesOf(compile)
					assert.equal(
						storesAlive(),
						before,
						`${shape}: no store outlives its compile, the compiled write and its subject held`
					)
					assert.ok(value !== undefined, `${shape}: the compile's value is held`)
					assert.equal(
						written,
						read,
						`${shape}: the templates written, one for each node and expression whose template is read`
					)
					if (counts.evaluations > 0) {
						k.note("an evaluation key digested")
					}
					if (counts.queries > 0) {
						k.note("a read-back's query digested")
					}
					if (counts.shares > 0) {
						k.note("a node the share planning keyed")
					}
					if (counts.kept > 0) {
						k.note("a read-back's program kept")
					}
				}),
			oracle: {
				kind: "specification",
				name: "one template written per distinct node and expression a compile reads"
			},
			box: "one and eight readers of one call of eight bound imports, a chain of eight bound levels, eight readers of a take bound to a variable, and a read-back's write compiled first and again over one subject",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/context.ts",
					original: '\t\tcase "write":\n\t\tcase "readBack":\n\t\t\treturn subject.templates\n',
					replacement:
						'\t\tcase "write":\n\t\tcase "readBack":\n\t\t\treturn new DagTemplates("derivation")\n',
					why: "The write's lowering and each read-back's read stores of their own, as each consumer held one: a node the share planning's keys or a read-back's digest read is written again by the lowering's evaluation keys, and the templates written pass the nodes read."
				},
				{
					file: "packages/engine/src/write/readback/lower.ts",
					original: "\tconst query = new QueryDigest(read.node)\n",
					replacement:
						"\tconst query = Object.assign(new QueryDigest(read.node), { templates: options.templates })\n",
					why: "A kept read-back's query holds the templates of the compile that kept it, so the store of every compile that keeps a read-back outlives it for as long as its subject's names, every node's template it wrote: the stores alive after the first compile pass those before."
				}
			]
		}
	)
