/**
 * The human line of a diagnostic (report/human.ts, design 8.1): a field drawn from characters of every General_Category
 * the design escapes, and of those it keeps, is sanitized character by character, each control, format character,
 * line or paragraph separator and lone surrogate written as its visible escape; a diagnostic drawn over every part of
 * the line (its severity, an operation with or without its id, a field refusal at its Encoding entry or off it, a hostile
 * character in each free-text part, the fields the line leaves out set or not) renders as design 8.1's grammar says.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { makeDiagnostic } from "#model/diagnostic.ts"
import { humanLine, sanitizeField } from "#report/human.ts"
import {
	expectedLine,
	type FieldFeature,
	fieldFeaturesOf,
	fieldSpace,
	type LineFeature,
	lineFeaturesOf,
	lineInputOf,
	lineSpace,
	sanitizedModel
} from "#test/report/human.fixtures.ts"

/** A drawn field sanitizes as the escapes design 8.1 writes say. It replaces human's two sanitizeField examples. */
export const sanitizedFields = property.explore(fieldSpace, {
	needs: {},
	situations: [
		"a control escaped",
		"a format escaped",
		"a separator escaped",
		"a surrogate escaped",
		"an ANSI escape made inert",
		"an astral character kept whole",
		"a space separator kept",
		"text with nothing to escape"
	],
	check: (_, c: Case<FieldFeature>) => (text) =>
		Effect.sync(() => {
			c.noteAll(fieldFeaturesOf(text))
			assert.equal(sanitizeField(text), sanitizedModel(text))
		}),
	oracle: {
		kind: "specification",
		name: "design 8.1 C8: each Cc, Cf, Zl, Zp and Cs code point as its `\\u{hex}` escape, every other kept, by Unicode's UnicodeData.txt"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/report/human.ts",
			original: "unsafeCharacter.test(character)",
			replacement: "!unsafeCharacter.test(character)",
			why: "Every safe character is escaped and every unsafe one kept, so an ANSI escape reaches the terminal; the property fails (CATCH's evidence, mutant fb3b5619ad)."
		},
		{
			file: "packages/generator/src/report/human.ts",
			original: "\\\\p{Cc}\\\\p{Cf}\\\\p{Zl}",
			replacement: "\\\\p{Cc}\\\\p{Zl}",
			why: "A format character, a right-to-left override say, is kept, so it reorders what the line shows; the property fails."
		},
		{
			file: "packages/generator/src/report/human.ts",
			original: "\\\\p{Cs}]$",
			replacement: "]$",
			why: "A lone surrogate is kept, so the line is no well-formed text; the property fails."
		},
		{
			file: "packages/generator/src/report/human.ts",
			original: "\\\\p{Zl}\\\\p{Zp}",
			replacement: "\\\\p{Z}",
			why: "Every space separator is escaped, a no-break space among them, where only the line and paragraph separators break a line; the property fails."
		},
		{
			file: "packages/generator/src/report/human.ts",
			original: "point.toString(16)",
			replacement: "point.toString(10)",
			why: "An escape names its code point in decimal, so `\\u{27}` stands for ESC; the property fails."
		},
		{
			file: "packages/generator/src/report/human.ts",
			original: "Arr.fromIterable(text)",
			replacement: 'Str.split("")(text)',
			why: "A field is read by UTF-16 unit, so an astral character's halves are escaped as two lone surrogates; the property fails."
		}
	]
})

/**
 * A drawn diagnostic's line is design 8.1's grammar over its parts. It replaces human's seven humanLine examples (the
 * field order, a notice's lead, the omitted parenthesis, a field at and off its Encoding entry, a hostile field and
 * media type, a hostile pointer, message and path).
 */
export const humanLines = property.explore(lineSpace, {
	needs: {},
	situations: [
		"a refusal",
		"a notice",
		"no operation",
		"an operation with its id",
		"an operation without its id",
		"a field at its Encoding entry",
		"a field off an Encoding entry",
		"an Encoding pointer outside a field refusal",
		"a field name with pointer escapes",
		"a hostile pointer",
		"a hostile message",
		"a hostile operation",
		"a hostile field",
		"the fields beside the line"
	],
	check: (_, c: Case<LineFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(lineFeaturesOf(sketch))
			const diagnostic = yield* makeDiagnostic(lineInputOf(sketch))
			assert.equal(humanLine(diagnostic), expectedLine(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "design 8.1's human line: severity, code, pointer, operation, a field refusal's field and media type, message and section, each part sanitized"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/report/human.ts",
			original: 'isRefusal(diagnostic) ? "refused" : "notice"',
			replacement: '"refused"',
			why: "A notice leads as a refusal; the property fails."
		},
		{
			file: "packages/generator/src/report/human.ts",
			original: `\`#\${sanitizeField(diagnostic.pointer)}\``,
			replacement: `\`#\${diagnostic.pointer}\``,
			why: "A pointer's control characters reach the terminal raw; the property fails."
		},
		{
			file: "packages/generator/src/report/human.ts",
			original: `const label = operation.operationId === undefined ? route : \`\${route}, \${operation.operationId}\``,
			replacement: "const label = route",
			why: "The operation's id is left out of its parenthesis; the property fails."
		},
		{
			file: "packages/generator/src/report/human.ts",
			original: 'diagnostic.scope === "field"',
			replacement: "true",
			why: "Every diagnostic names a field, where only a field refusal does; the property fails."
		},
		{
			file: "packages/generator/src/report/human.ts",
			original: 'keyword === "encoding"',
			replacement: "true",
			why: "A field refusal off an Encoding entry names its pointer's last token as the field, where it names its element; the property fails."
		},
		{
			file: "packages/generator/src/report/human.ts",
			original: "JsonPointer.unescapeToken(name)",
			replacement: "name",
			why: "A field's name keeps its pointer escapes, `a~1b` for `a/b`; the property fails."
		}
	]
})
