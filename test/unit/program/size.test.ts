import { defined } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { affine } from "#test/support/growth.ts"
import { extent, sizesOf } from "#test/unit/program/size.fixtures.ts"

/** Compiled size a query attaching n, 2n and 3n relations compiles to statements that grow by the same nodes from each to the next. */
export const compiledSizeAQueryAttachingN2nAnd3nRelationsCompilesToStatementsThatGrowByTheSameNodesFromEachToTheNext =
	property.exhaust(
		finite((source) => [source.draw(extent), source.draw(extent)] as const),
		{
			needs: {},
			situations: [],
			check:
				() =>
				([width, n]) =>
					Effect.sync(() => {
						const measured = new Map(
							Arr.map([n, 2 * n, 3 * n], (k) => [k, sizesOf(k, width)] as const)
						)
						for (const artifact of ["conservative", "optimized"] as const) {
							affine(
								(k) => defined(measured.get(k), `the sizes at ${k} attachments`)[artifact],
								n,
								`the ${artifact} artifact's nodes over children of ${width} fields`
							)
						}
					}),
			oracle: { kind: "universal", name: "f(3n) − f(2n) = f(2n) − f(n)" },
			box: "every width and size of one to three",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/parts.ts",
					original:
						"\t\tconst padding: ReadonlyArray<Expr> = Array.from({ length: width - p.columns.length }, () =>",
					replacement:
						"\t\tconst padding: ReadonlyArray<Expr> = Array.from({ length: width - p.columns.length + parts.length }, () =>",
					why: "Every part of a statement is padded by one column per part (lower/parts.ts taggedParts), a part that grows with its siblings; the parts promise the compilation is verified against (the tag and each part's cells) fails first, at every n."
				}
			]
		}
	)
