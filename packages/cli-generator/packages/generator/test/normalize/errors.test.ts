import { describe, expect, test } from "vitest"
import { BodyNotReadable } from "#normalize/bodies.ts"
import { ParameterNotReadable } from "#normalize/parameters.ts"
import { SchemaImportDefect } from "#normalize/schemas.ts"

describe("normalize error classes", () => {
	test("normalize errors are schema classes", () => {
		const defect = new SchemaImportDefect({ key: "#/components/schemas/A", message: "no import" })
		expect(defect._tag).toBe("SchemaImportDefect")
		expect(defect.key).toBe("#/components/schemas/A")
		expect(defect.message).toBe("no import")

		const parameter = new ParameterNotReadable({ pointer: "/info", reason: "not-a-parameter" })
		expect(parameter._tag).toBe("ParameterNotReadable")
		expect(parameter.pointer).toBe("/info")
		expect(parameter.reason).toBe("not-a-parameter")

		const body = new BodyNotReadable({ pointer: "/info", reason: "not-a-request-body" })
		expect(body._tag).toBe("BodyNotReadable")
		expect(body.pointer).toBe("/info")
		expect(body.reason).toBe("not-a-request-body")

		const outside = [{ pointer: "/info", reason: "not-a-reason" }]
		expect(() => {
			Reflect.construct(ParameterNotReadable, outside)
		}).toThrow()
		expect(() => {
			Reflect.construct(BodyNotReadable, outside)
		}).toThrow()
	})
})
