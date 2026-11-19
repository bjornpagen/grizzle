/** What the properties of proved-cast.test.ts read: the stored text types, the text maps over them, and each site. */

import type * as Result from "@bjornpagen/grizzle-text/base/result"
import type { Gen } from "@bjornpagen/testing/gen"
import { element } from "@bjornpagen/testing/gen"
import type { CompileError } from "#compiler/core/errors.ts"
import {
	compileInstallation,
	type Installation,
	installOptions
} from "#compiler/physical/install/compile.ts"
import { Compute } from "#compiler/public/compute.ts"
import { generated } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, derived, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id } from "#test/support/ids.ts"
import { owning } from "#test/support/policy.ts"

/** The stored text types an operand is drawn of: any text of a byte bound, and patterns with and without white space. */
const operands = [
	{ name: "a key text", text: str.bytes(428, str.regex("^.*$", "su")) },
	{ name: "words", text: str.regex("^[ a-zA-Z]{0,40}$", "u") },
	{ name: "a tabbed line", text: str.regex("^[\\t a-z]{1,30}$", "u") },
	{ name: "a lower-case name", text: str.regex("^[a-z]{1,8}$", "u") }
] as const

/** The operand's text type, as its relation's field declares it. */
export type Operand = (typeof operands)[number]

/** The text maps a site reads the image of. */
const textMaps = ["collapse", "replaceWhitespace", "lowerAscii", "translate"] as const
export type TextMap = (typeof textMaps)[number]

/**
 * Where a computed text is read: a containment of a stored text into a derived relation's head that computes it, whose
 * two sides the law relabels to their common type, or a generated field that casts it into a text type no stored field
 * declares, any text of more bytes than the operand holds, so the cast is total by the bound alone.
 */
const sites = ["containment", "generated cast"] as const
export type Site = (typeof sites)[number]

export interface ProvedCastCase {
	readonly operand: Operand
	readonly map: TextMap
	readonly site: Site
}

export const provedCastCaseGen: Gen<ProvedCastCase> = (source) => ({
	operand: source.draw(element(operands)),
	map: source.draw(element(textMaps)),
	site: source.draw(element(sites))
})

/** Any text, the generated field's own type, of no refinement. */
const anyText = str.regex("^.*$", "su")

/**
 * The text type no stored field declares that a generated cast's target is: any text of more bytes than every operand's
 * image holds.
 */
const undeclared = str.bytes(4096, anyText)

/** The case's schema, its site reading the map's image of the operand. */
const schemaOf = (c: ProvedCastCase) => {
	switch (c.site) {
		case "containment": {
			const Source = relation("Source", { lex: c.operand.text, node: Id }, ["node"])
			const Named = relation("Named", { id: Id, t: c.operand.text }, ["id"])
			const base = schema("Base", [Source, Named], [])
			const Image = derived(
				"Image",
				query(base).rule((r) => {
					const { lex, node } = v(Source, "s")
					const read = r.match(Source, { lex, node })
					switch (c.map) {
						case "collapse":
							return read.find({ image: Compute.collapse(lex), node })
						case "replaceWhitespace":
							return read.find({ image: Compute.replaceWhitespace(lex), node })
						case "lowerAscii":
							return read.find({ image: Compute.lowerAscii(lex), node })
						case "translate":
							return read.find({ image: Compute.translate(lex, "ab", "ba"), node })
					}
				})
			)
			return schema.extend(base, "Images", [Image], [contained(on(Named, "t"), on(Image, "image"))])
		}
		case "generated cast":
			return schema(
				"Cast",
				[
					relation.generated("Cast", { lex: c.operand.text, node: Id }, ["node"], (row) => {
						switch (c.map) {
							case "collapse":
								return {
									image: generated(anyText, Compute.cast(Compute.collapse(row.lex), undeclared))
								}
							case "replaceWhitespace":
								return {
									image: generated(
										anyText,
										Compute.cast(Compute.replaceWhitespace(row.lex), undeclared)
									)
								}
							case "lowerAscii":
								return {
									image: generated(anyText, Compute.cast(Compute.lowerAscii(row.lex), undeclared))
								}
							case "translate":
								return {
									image: generated(
										anyText,
										Compute.cast(Compute.translate(row.lex, "ab", "ba"), undeclared)
									)
								}
						}
					})
				],
				[]
			)
	}
}

/** The installation of the case's schema, as grizzle generate compiles a fresh one. */
export const installed = (c: ProvedCastCase): Result.Result<Installation, CompileError> => {
	const owned = owning(schemaOf(c))
	return compileInstallation(owned, installOptions(owned))
}
