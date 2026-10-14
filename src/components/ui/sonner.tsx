"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useTheme } from "@/components/theme-provider"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4 text-success" />
        ),
        info: (
          <InfoIcon className="size-4 text-pill-blue-fg" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4 text-pill-yellow-fg" />
        ),
        error: (
          <OctagonXIcon className="size-4 text-danger" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "16px",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          // Soft UI: rounded tile, soft shadow, Inter body text.
          toast: "cn-toast !gap-2.5 !px-4 !py-3.5 !font-sans !shadow-popover",
          description: "!text-ink-secondary",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
