"use client"

import {
  AnimatePresence,
  motion,
  useMotionValue,
  useTransform,
  type MotionValue,
} from "motion/react"
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  Children,
  isValidElement,
  useCallback,
  type ReactNode,
  type RefObject,
} from "react"
import { useMotionUITheme, useMotionUITransition } from "@/components/motion-ui/ui-theme"

/**
 * Sheet - the springy bottom-sheet mechanic on the native HTML dialog
 * element. A trigger opens a panel that fades up 50px over a dimming scrim; the panel is
 * draggable on the y-axis and dismisses on a downward drag past an offset OR
 * a flick past a velocity threshold, plus scrim-click, close-button and
 * Escape dismissal. The scrim's opacity tracks the drag, so the background
 * un-dims in lockstep as the sheet is pulled down.
 *
 * The API is composable parts, not a finished page: you already have your
 * own trigger and your own sheet content. What ships here is the
 * choreography grafted onto the browser's modal dialog accessibility and
 * interaction primitives:
 *
 *  - `Sheet` owns the native `<dialog>` and the controlled/uncontrolled state.
 *  - `SheetTrigger` opens the dialog.
 *  - `SheetBackdrop` is the drag-linked dismiss surface.
 *  - `SheetPanel` is the draggable spring panel; `dismissOffset` /
 *    `dismissVelocity` are its two shape props.
 *  - `SheetHandle` is the decorative grab affordance.
 *  - `SheetClose` closes the dialog.
 *  - `useSheet()` reads/controls the open state for consumer choreography.
 *
 * `SheetBackdrop` and `SheetPanel` should be direct children of `Sheet`. The
 * root moves those two parts into the dialog while leaving all other children
 * (including the trigger and resting page content) in place.
 *
 * Styling reads only shadcn's semantic Tailwind vocabulary; timing reads only
 * the Motion UI theme (`@motion/ui-theme`) - the sheet and scrim ride
 * `gentle` (large surfaces), press feedback rides `snap`. Feel is never a
 * prop.
 */

/**
 * ==============   Reduced motion   ================
 */

/** Theme reduced-motion strategy, shared by every part: "off" mounts no
 *  animation (the sheet is just there, no spring/drag); "calm" keeps opacity
 *  fades but drops travel (no slide-up, no drag). `defaultTheme` ships
 *  "calm". Drag is travel, so it is disabled under either. */

/**
 * ==============   Sheet (context)   ================
 */

interface SheetContextValue {
  /** Whether the sheet is open. */
  open: boolean
  /** Open/close the sheet. */
  setOpen: (open: boolean) => void
  /** The sheet's live y-offset - the drag drives it, the scrim reads it. */
  y: MotionValue<number>
  /** Distance over which a downward drag fully fades the scrim. */
  hiddenY: number
  /** Ref to the trigger, so focus returns to it when the sheet closes. */
  triggerRef: RefObject<HTMLButtonElement | null>
  /** Ref to the native dialog element. */
  dialogRef: RefObject<HTMLDialogElement | null>
  /** Ref to the visual sheet panel. */
  panelRef: RefObject<HTMLDivElement | null>
  /** Ref to the close button, where focus moves on open. */
  closeRef: RefObject<HTMLButtonElement | null>
  /** The resolved reduced-motion mode for this render. */
  motionMode: { still: boolean; calm: boolean; motionAllowed: boolean }
}

const SheetContext = createContext<SheetContextValue | null>(null)

function useSheetContext(part: string): SheetContextValue {
  const context = useContext(SheetContext)
  if (!context) {
    throw new Error(`${part} must be rendered inside <Sheet>.`)
  }
  return context
}

/** The public open-state handle: `useSheet()` reads and controls whether the
 *  sheet is open. The native dialog owns modal focus and background inerting. */
export interface UseSheet {
  open: boolean
  setOpen: (open: boolean) => void
}

/** Reads the enclosing sheet's open state (and setter), or drives the sheet
 *  from your own control. The native dialog handles the modal background
 *  state. Must be used inside `Sheet`. */
export function useSheet(): UseSheet {
  const { open, setOpen } = useSheetContext("useSheet()")
  return { open, setOpen }
}

export interface SheetProps {
  /** The trigger, backdrop, panel and your resting content. Keep the backdrop
   *  and panel as direct children so the root can place them in the dialog. */
  children?: ReactNode
  /** Controlled open state. Omit for uncontrolled (drive it via
   *  `SheetTrigger` / `SheetClose` / the drag). */
  open?: boolean
  /** Initial open state when uncontrolled. Defaults to `false`. */
  defaultOpen?: boolean
  /** Called whenever the sheet requests an open-state change (trigger, close
   *  button, scrim, Escape, drag-dismiss). Required to observe controlled
   *  changes. */
  onOpenChange?: (open: boolean) => void
}

/**
 * The coordinating root: adapts controlled or uncontrolled state to a native
 * `<dialog>`, shares the drag position and element refs through context, and
 * keeps the overlay mounted until its Motion exit animation completes.
 */
export function Sheet({
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
}: SheetProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : uncontrolledOpen

  const y = useMotionValue(0)
  const hiddenY = 420
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const { motionMode } = useMotionUITheme()
  const still = motionMode === "off"
  const calm = motionMode === "calm"
  const motionAllowed = motionMode === "full"

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [isControlled, onOpenChange]
  )

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!open || !dialog || dialog.open) return
    dialog.showModal()
    closeRef.current?.focus({ preventScroll: true })
  }, [open])

  useEffect(() => {
    if (!open) return
    const root = document.documentElement
    const previousOverflow = root.style.overflow
    root.style.overflow = "hidden"
    return () => {
      root.style.overflow = previousOverflow
    }
  }, [open])

  const pageParts: ReactNode[] = []
  const overlayParts: ReactNode[] = []
  let labelledBy = "velocity-sheet-title"
  for (const child of Children.toArray(children)) {
    if (
      isValidElement(child) &&
      (child.type === SheetBackdrop || child.type === SheetPanel)
    ) {
      overlayParts.push(child)
      if (child.type === SheetPanel) {
        labelledBy =
          (child.props as SheetPanelProps).labelledBy ?? "velocity-sheet-title"
      }
    } else {
      pageParts.push(child)
    }
  }

  return (
    <SheetContext.Provider
      value={{
        open,
        setOpen,
        y,
        hiddenY,
        triggerRef,
        dialogRef,
        panelRef,
        closeRef,
        motionMode: { still, calm, motionAllowed },
      }}
    >
      {pageParts}
      <motion.dialog
        ref={dialogRef}
        aria-labelledby={labelledBy}
        className="fixed inset-0 z-50 m-0 h-dvh max-h-none w-screen max-w-none overflow-hidden border-0 bg-transparent p-0 text-foreground backdrop:bg-transparent"
        onCancel={(event) => {
          event.preventDefault()
          setOpen(false)
        }}
        onClose={() => {
          if (open) setOpen(false)
        }}
      >
        <AnimatePresence
          onExitComplete={() => {
            const dialog = dialogRef.current
            if (!open && dialog?.open) {
              dialog.close()
              triggerRef.current?.focus({ preventScroll: true })
            }
          }}
        >
          {open && overlayParts}
        </AnimatePresence>
      </motion.dialog>
    </SheetContext.Provider>
  )
}

/**
 * ==============   SheetTrigger   ================
 */

/** shadcn's ring utilities, the shared focus-visible treatment. The trigger
 *  sits on the page/card surface, so its ring offset tracks `--card`. */
const FOCUS_RING =
  "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"

export interface SheetTriggerProps {
  /** The trigger's contents (label, and optionally an icon). */
  children?: ReactNode
  /** Merged onto the trigger button, last, so it wins. */
  className?: string
}

/**
 * The styled trigger that opens the sheet: a primary fill with the theme's
 * `snap` hover/tap feel and the shared focus ring.
 */
export function SheetTrigger({ children, className }: SheetTriggerProps) {
  const { setOpen, triggerRef, motionMode } = useSheetContext("SheetTrigger")
  const snap = useMotionUITransition("snap")

  return (
    <motion.button
      ref={triggerRef}
      type="button"
      className={`inline-flex h-11 items-center gap-2 rounded-sm bg-primary px-[1.125rem] text-[0.9375rem] font-medium text-primary-foreground ${FOCUS_RING}${className ? ` ${className}` : ""}`}
      onClick={() => setOpen(true)}
      whileHover={motionMode.motionAllowed ? { scale: 1.05 } : undefined}
      whileTap={motionMode.motionAllowed ? { scale: 0.95 } : undefined}
      transition={{ ...snap }}
    >
      {children}
    </motion.button>
  )
}

/**
 * ==============   SheetBackdrop   ================
 */

export interface SheetBackdropProps {
  /** The scrim surface class, merged onto the shared `Backdrop`. Defaults to
   *  the universal `bg-black` modal scrim; pass a section-local veil (e.g. a
   *  `color-mix(in srgb, var(--background) 72%, transparent)` class) to tint
   *  it to your ground colour in both modes. */
  className?: string
  /** The scrim's accessible label. When set, the scrim is a keyboard-reachable
   *  dismiss button; omit it for a decorative scrim. */
  label?: string
}

/**
 * The dimming scrim behind the open sheet. Its opacity follows the sheet's
 * drag position so it un-dims as the sheet is pulled down.
 */
export function SheetBackdrop({ className, label }: SheetBackdropProps) {
  const { setOpen, y, hiddenY, motionMode } =
    useSheetContext("SheetBackdrop")
  const gentle = useMotionUITransition("gentle")
  // At rest (y=0) the scrim is fully drawn; at the hidden distance it is gone.
  const dragOpacity = useTransform(y, [0, hiddenY], [1, 0])
  const { still, motionAllowed } = motionMode
  const surfaceClass = className ?? "bg-black"

  if (label) {
    return (
      <motion.button
        type="button"
        aria-label={label}
        className={`fixed inset-0 z-40 border-0 p-0 ${surfaceClass}`}
        style={{ opacity: motionAllowed ? dragOpacity : 1 }}
        initial={still ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={still ? undefined : { opacity: 0 }}
        transition={{ ...gentle }}
        onClick={() => setOpen(false)}
      />
    )
  }

  return (
    <motion.div
      aria-hidden="true"
      className={`fixed inset-0 z-40 ${surfaceClass}`}
      style={{ opacity: motionAllowed ? dragOpacity : 1 }}
      initial={still ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={still ? undefined : { opacity: 0 }}
      transition={{ ...gentle }}
    />
  )
}

/**
 * ==============   SheetPanel   ================
 */

/**
 * Whether a drag release should dismiss the sheet: a downward drag past
 * `dismissOffset` (px) OR a downward flick past `dismissVelocity` (px/s).
 * Both thresholds are downward-only (positive y is down), so an upward
 * over-drag never dismisses. Exported so the dismiss contract is
 * unit-testable without a browser (the drag gesture itself is browser-only).
 *
 * @param offsetY - The release drag offset on the y-axis, px (down positive).
 * @param velocityY - The release velocity on the y-axis, px/s (down positive).
 * @param dismissOffset - The distance threshold, px.
 * @param dismissVelocity - The flick-velocity threshold, px/s.
 */
export function shouldDismissSheet(
  offsetY: number,
  velocityY: number,
  dismissOffset: number,
  dismissVelocity: number
): boolean {
  return offsetY > dismissOffset || velocityY > dismissVelocity
}

export interface SheetPanelProps {
  /** The sheet's contents - your handle, header, close button and rows. */
  children?: ReactNode
  /** Downward drag distance (px) past which releasing dismisses the sheet.
   *  Defaults to `92`. */
  dismissOffset?: number
  /** Downward flick velocity (px/s) past which releasing dismisses the sheet.
   *  Defaults to `840`. */
  dismissVelocity?: number
  /** The id of the element that labels the dialog, wired to
   *  `aria-labelledby`. Put this same id on your sheet's heading. Defaults to
   *  `"velocity-sheet-title"`. */
  labelledBy?: string
  /** Merged onto the panel, last, so it wins. */
  className?: string
}

/**
 * The draggable spring panel. Fades up 50px on open (theme `gentle`),
 * is draggable on the y-axis with a bottom-weighted elastic, and dismisses on
 * a downward drag past `dismissOffset` OR a flick past `dismissVelocity`.
 * Modal semantics come from the native dialog owned by `Sheet`.
 */
export function SheetPanel({
  children,
  dismissOffset = 92,
  dismissVelocity = 840,
  className,
}: SheetPanelProps) {
  const {
    open,
    setOpen,
    y,
    panelRef,
    motionMode,
  } = useSheetContext("SheetPanel")
  const gentle = useMotionUITransition("gentle")
  const { still, calm, motionAllowed } = motionMode

  // Reset any residual drag whenever the sheet opens.
  useEffect(() => {
    if (!open) return
    y.set(0)
  }, [open, y])

  return (
    <motion.div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50"
      initial={
        still
          ? false
          : {
              transform: calm ? "translateY(0px)" : "translateY(50px)",
              opacity: 0,
            }
      }
      animate={{ transform: "translateY(0px)", opacity: 1 }}
      exit={
        still
          ? undefined
          : {
              transform: calm ? "translateY(0px)" : "translateY(50px)",
              opacity: 0,
            }
      }
      transition={{ ...gentle }}
    >
      <motion.div
        ref={panelRef}
        className={`pointer-events-auto mx-auto mb-2 w-[calc(100%-1rem)] max-w-md rounded-lg border border-border bg-background px-5 pb-6 text-foreground shadow-2xl sm:mb-3 sm:w-[calc(100%-1.5rem)] ${motionAllowed ? "cursor-grab" : ""}${className ? ` ${className}` : ""}`}
        // touch-action:none so a vertical drag on a touch device is captured
        // by Motion rather than scrolling the page.
        style={{ y, touchAction: "none" }}
        drag={motionAllowed ? "y" : false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.15, bottom: 0.8 }}
        dragMomentum={motionAllowed}
        whileDrag={motionAllowed ? { cursor: "grabbing" } : undefined}
        onDragEnd={(_, info) => {
          if (
            shouldDismissSheet(
              info.offset.y,
              info.velocity.y,
              dismissOffset,
              dismissVelocity
            )
          ) {
            setOpen(false)
          }
        }}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}

/**
 * ==============   SheetHandle   ================
 */

export interface SheetHandleProps {
  /** Merged onto the centring row, last, so it wins. */
  className?: string
}

/**
 * The decorative grab affordance at the top of the sheet: a short pill,
 * `aria-hidden` (a mouse/touch handle, not a control). Its tone is a faint,
 * below-AA derived ink - fine here because the mark is decorative and hidden
 * from assistive tech.
 */
export function SheetHandle({ className }: SheetHandleProps) {
  return (
    <div
      className={`flex justify-center pt-3 pb-1${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      <div
        className="h-1 w-10 rounded-full"
        style={{
          backgroundColor:
            "color-mix(in srgb, var(--muted-foreground) 62%, var(--background))",
        }}
      />
    </div>
  )
}

/**
 * ==============   SheetClose   ================
 */

export interface SheetCloseProps {
  /** The button's contents. Defaults to a close (×) glyph. */
  children?: ReactNode
  /** The accessible label. Defaults to `"Close"`. */
  label?: string
  /** Merged onto the button, last, so it wins. */
  className?: string
}

/**
 * The close button, top-right of the sheet. Carries the close ref, so focus
 * lands here when the sheet opens; the theme's `snap` colour fade on hover and
 * the shared focus ring. Renders a default × glyph, overridable via children.
 */
export function SheetClose({ children, label = "Close", className }: SheetCloseProps) {
  const { setOpen, closeRef } = useSheetContext("SheetClose")

  return (
    <button
      ref={closeRef}
      type="button"
      aria-label={label}
      className={`flex size-8 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground transition-colors duration-[var(--motion-ui-transition-snap-duration)] ease-[var(--motion-ui-transition-snap)] hover:bg-accent hover:text-foreground ${FOCUS_RING}${className ? ` ${className}` : ""}`}
      onClick={() => setOpen(false)}
    >
      {children ?? <CloseGlyph />}
    </button>
  )
}

/** The default close glyph (Lucide "x"), `stroke="currentColor"` so it inherits
 *  the button's text colour. Inlined - no icon dependency. */
function CloseGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}
