import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// 널널투어 v2 시스템 — 버튼은 알약(radius 999)이다. 주 CTA 만 브랜드 채움, 나머지는
// 헤어라인 테두리(--border-strong) 또는 배경 없음. 그림자는 쓰지 않는다.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "bg-primary font-semibold text-primary-foreground hover:bg-brand-press",
        destructive:
          "bg-destructive font-semibold text-white hover:bg-destructive/90 focus-visible:ring-destructive/20",
        outline:
          "border border-border-strong bg-transparent font-medium text-foreground hover:bg-muted",
        secondary:
          "bg-secondary font-medium text-secondary-foreground hover:bg-secondary/80",
        ghost: "font-medium text-muted-foreground hover:bg-muted hover:text-foreground",
        link: "font-semibold text-brand-strong underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-[18px]",
        xs: "h-6 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 px-3 text-[13px]",
        lg: "h-12 px-6",
        icon: "size-10",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
