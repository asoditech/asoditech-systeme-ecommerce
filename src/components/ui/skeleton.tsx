import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-xl bg-segment-track motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Skeleton }
