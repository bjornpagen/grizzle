import type { RuleTester } from "oxlint/plugins-dev"
import { BESIDE_TEXT_MESSAGE, DETACHED_MESSAGE, STRIP_MESSAGE } from "#oxlint/rules/no-comment.ts"

const ts = { filename: "/repository/module.ts" } as const
const tsx = { filename: "/repository/component.tsx" } as const

/**
 * no-comment's cases, run on oxlint's RuleTester by src/oxlint/fixtures.ts: the comments it keeps, and for each comment
 * it reports, the line and the text its fix leaves (null where it reports without a fix). A marked fixture cannot
 * prove it, because its marker is a comment the rule strips.
 */
export const NO_COMMENT_CASES: Parameters<RuleTester["run"]>[2] = {
	valid: [
		{ ...ts, code: "/** The answer. */\nexport const a = 1\n" },
		{
			...ts,
			code: "export interface Shape {\n\t/** Its kind. */\n\treadonly kind: string\n}\nexport class Box {\n\t/** Its size. */\n\tsize = 1\n\t/** Grows it. */\n\tgrow(): void {}\n}\nexport const make = (/** The size. */ size: number): number => size\nexport const object = {\n\t/** A field. */\n\tfield: 1\n}\nexport type Pair</** The left. */ L, R> = readonly [L, R]\nexport enum Kind {\n\t/** The first. */\n\tFirst\n}\n"
		},
		{ ...ts, code: "/*! legal */\nexport const a = 1\n" },
		{ ...ts, code: "/* @license MIT */\nexport const a = 1\n" },
		{ ...ts, code: "export const pure = /*#__PURE__*/ Object.freeze({})\n" },
		{
			...ts,
			code: "/* @__NO_SIDE_EFFECTS__ */\nexport function make(): number {\n\treturn 1\n}\n"
		},
		{
			...ts,
			code: 'export const lazy = import(/* webpackChunkName: "lazy" */ "#lazy.ts")\nexport const next = import(/* turbopackOptional: true */ "#next.ts")\n'
		},
		{ ...ts, code: '/// <reference types="node" />\nexport const a = 1\n' },
		{ ...tsx, code: "/** @jsxImportSource preact */\nexport const a = <b />\n" },
		{ ...tsx, code: "// @jsxImportSource preact\nexport const a = <b />\n" },
		{ ...ts, code: "// oxfmt-ignore\nexport const matrix = [1,0,\n0,1]\n" },
		{ ...ts, code: "// prettier-ignore\nexport const matrix = [1,0,\n0,1]\n" },
		{
			...ts,
			code: "// oxlint-disable-next-line eslint/no-console\nexport const log = console.log\n"
		},
		{ ...ts, code: "/* @effect-diagnostics floatingEffect:off */\nexport const a = 1\n" },
		{ ...ts, code: '// @ts-expect-error a refusal under test\nexport const a: number = "x"\n' },
		{
			...ts,
			code: "#!/usr/bin/env -S node --import=file:///repository/register.ts\nexport const a = 1\n"
		},
		{ ...ts, code: 'export const url = "https://example.com/* not a comment */"\n' }
	],
	invalid: [
		{
			...ts,
			code: "export const a = 1\n\t// a note\nexport const b = 2\n",
			output: "export const a = 1\nexport const b = 2\n",
			errors: [{ message: STRIP_MESSAGE, line: 2 }]
		},
		{
			...ts,
			code: "export const a = 1 // a trailing note\n",
			output: "export const a = 1\n",
			errors: [{ message: STRIP_MESSAGE, line: 1 }]
		},
		{
			...ts,
			code: "export const a = /* an inline note */ 1\n",
			output: "export const a = 1\n",
			errors: [{ message: STRIP_MESSAGE, line: 1 }]
		},
		{
			...ts,
			code: "/* a block note */\nexport const depth = 5\n",
			output: "export const depth = 5\n",
			errors: [{ message: STRIP_MESSAGE, line: 1 }]
		},
		{
			...ts,
			code: "/**/\nexport const empty = 0\n",
			output: "export const empty = 0\n",
			errors: [{ message: STRIP_MESSAGE, line: 1 }]
		},
		{
			...ts,
			code: "// read the oxlint-disable docs first\nexport const a = 1\n",
			output: "export const a = 1\n",
			errors: [{ message: STRIP_MESSAGE, line: 1 }]
		},
		{
			...ts,
			code: "/* note: webpackChunkName names a chunk */\nexport const chunk = 1\n",
			output: "export const chunk = 1\n",
			errors: [{ message: STRIP_MESSAGE, line: 1 }]
		},
		{
			...tsx,
			code: "export const element = <b>{/* between nothing */}</b>\n",
			output: "export const element = <b></b>\n",
			errors: [{ message: STRIP_MESSAGE, line: 1 }]
		},
		{
			...tsx,
			code: "export const E = () => (\n\t<div>\n\t\t{/* a note */}\n\t\t<span />\n\t</div>\n)\n",
			output: "export const E = () => (\n\t<div>\n\t\t<span />\n\t</div>\n)\n",
			errors: [{ message: STRIP_MESSAGE, line: 3 }]
		},
		{
			...ts,
			code: "export const run = (): number => {\n\t/** Before a return. */\n\treturn 1\n}\n",
			output: null,
			errors: [{ message: DETACHED_MESSAGE, line: 2 }]
		},
		{
			...ts,
			code: "export const value = /** Before an expression. */ 1\n",
			output: null,
			errors: [{ message: DETACHED_MESSAGE, line: 1 }]
		},
		{
			...ts,
			code: "export const a = 1\n/** At the end of the file. */\n",
			output: null,
			errors: [{ message: DETACHED_MESSAGE, line: 2 }]
		},
		{
			...tsx,
			code: "export const inline = <p>Hello {/* inside a line of text */} world</p>\n",
			output: null,
			errors: [{ message: BESIDE_TEXT_MESSAGE, line: 1 }]
		},
		{
			...tsx,
			code: "export const G = () => (\n\t<p>\n\t\tHello\n\t\t{/* between two lines */}\n\t\tworld\n\t</p>\n)\n",
			output: null,
			errors: [{ message: BESIDE_TEXT_MESSAGE, line: 4 }]
		}
	]
}
