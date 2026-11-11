import { cva } from "class-variance-authority"
import localFont from "next/font/local"
import { cn } from "#style/fixtures/support/cn.ts"

const WEIGHTS: Readonly<Record<"sm" | "lg", string>> = { sm: "font-medium", lg: "font-black" }

const sizes = cva("inline-flex", { variants: { size: { sm: "h-7", lg: "h-9" } } })

const TONES = { calm: "text-muted-foreground", loud: "text-destructive" } as const
const inter = localFont({ src: "./inter.woff2", variable: "--font-inter" })

export function VerifiableFixture({
	className,
	tone,
	size,
	labelClassName
}: Readonly<{
	className?: string
	tone: keyof typeof TONES
	size: "sm" | "lg"
	labelClassName?: string
}>) {
	const sized = size === "sm" ? "text-sm" : "text-lg"
	return (
		<div className={cn("flex", TONES[tone], sized, className)}>
			<span className={inter.variable} />
			<span className={labelClassName} />
			<span className={size === "sm" ? "p-2" : undefined} />
			<span className={sizes({ size, className })} />
			<span className={WEIGHTS[size]} />
		</div>
	)
}
