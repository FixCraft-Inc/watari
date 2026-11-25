/**
 * What Ctrl+C means, and why it is not one thing.
 *
 * In a terminal Ctrl+C is the universal "stop what you are doing", and users
 * press it reflexively. Watari previously bound it straight to detach, so the
 * reflex that normally clears a half-typed line tore the UI down instead. It
 * also collided with the other reflex — Ctrl+C as copy — which is what people
 * coming from a GUI editor expect.
 *
 * The resolution is a progression from the most local effect to the least, so
 * the key always undoes the smallest thing in front of the user, and detaching
 * takes a deliberate second press:
 *
 *   1. a live selection            → drop the selection
 *   2. text in the composer        → clear the composer
 *   3. nothing to clear            → arm, and say so
 *   4. armed, pressed again        → detach
 *
 * Copy is Ctrl+Shift+C, which is what a terminal user already means by copy,
 * and which the terminal itself will handle instead when it has its own
 * binding for it. Nothing here ever stops the peers: a native turn is
 * interrupted through `/interrupt`, and the service outlives the UI by design.
 */

export type CtrlCOutcome =
  | "clear-selection"
  | "clear-composer"
  | "arm-detach"
  | "detach";

export interface CtrlCContext {
  readonly hasSelection: boolean;
  readonly composer: string;
  /** A previous Ctrl+C armed detach and has not expired yet. */
  readonly armed: boolean;
}

export function resolveCtrlC(context: CtrlCContext): CtrlCOutcome {
  if (context.hasSelection) return "clear-selection";
  if (context.composer.trim() !== "") return "clear-composer";
  return context.armed ? "detach" : "arm-detach";
}

/** How long an armed detach waits for the second press. */
export const DETACH_ARM_MS = 3_000;

/**
 * Whether this key event is the copy chord.
 *
 * Only reachable when the terminal reports modifiers separately, which needs
 * the kitty keyboard protocol; without it Ctrl+Shift+C is indistinguishable
 * from Ctrl+C, and most terminals keep the chord for their own copy anyway. So
 * a plain alternative is offered alongside it rather than instead of it.
 */
export function isCopyChord(key: {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
  /** Kitty and a few terminal adapters preserve the shifted text here even
   * when they normalize `name` to lowercase. */
  readonly sequence?: string;
  readonly raw?: string;
}): boolean {
  if (!key.ctrl) return false;
  if (key.name === "y") return true;
  if (key.name.toLowerCase() !== "c") return false;
  if (key.shift || key.name === "C" || key.sequence === "C") return true;
  // Kitty's CSI-u form can arrive through a compatibility parser that does
  // not expose modifiers separately. The final `;6u` is Ctrl+Shift.
  return /(?:;6u|;6~)$/u.test(key.raw ?? "");
}

/** Whether this key event is the plain Ctrl+C the progression above governs. */
export function isCancelChord(key: {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
}): boolean {
  return key.ctrl && key.name.toLowerCase() === "c" && !key.shift && key.name !== "C";
}
