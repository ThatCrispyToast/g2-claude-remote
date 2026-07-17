// The Compose menu model — the ordered set of keyboard-free actions the wearer
// can fire on a session by scrolling to one and tapping. Pure data + tiny
// helpers; the state machine in main.ts drives selection and dispatch.

import { MODELS, MODES, QUICK_SENDS } from '../config'
import { HUD } from '../glasses'
import type { PermissionMode } from '../rc/types'

export type ComposeAction =
  | { kind: 'prompt'; label: string }
  | { kind: 'send'; label: string; text: string }
  | { kind: 'voice'; label: string }
  | { kind: 'interrupt'; label: string }
  | { kind: 'submenu'; label: string; menu: 'model' | 'mode' }
  | { kind: 'archive'; label: string }
  | { kind: 'back'; label: string }

/**
 * The top-level Compose menu, in display order — ordered by how often the wearer
 * reaches for each on a keyboard-less device. Dictate leads (it's the only
 * open-ended input path), then the one-tap canned sends, then the run controls
 * (Interrupt), then the rarer steering (Model / Mode), then Archive, then Back.
 */
export function composeActions(opts: { voiceAvailable: boolean; pendingPrompt?: string | null }): ComposeAction[] {
  const actions: ComposeAction[] = []
  // 0) A blocking prompt the wearer set aside ("answer later"). The session is
  //    waiting on it, so it leads the menu; tapping it reopens the question /
  //    permission screen. Absent when nothing is pending.
  if (opts.pendingPrompt) actions.push({ kind: 'prompt', label: opts.pendingPrompt })
  // 1) Dictate — the primary, open-ended input. Top of the list. `»` reads as
  //    "say" (the mic glyph isn't in the firmware font). Omitted with no key.
  if (opts.voiceAvailable) actions.push({ kind: 'voice', label: `${HUD.USER} Dictate a message` })
  // 2) One-tap canned sends.
  for (const q of QUICK_SENDS) actions.push({ kind: 'send', label: `${HUD.SEND} ${q.label}`, text: q.text })
  // 3) Run controls, then steering, then the destructive/exit tail.
  actions.push({ kind: 'interrupt', label: `${HUD.STOP} Interrupt` })
  actions.push({ kind: 'submenu', label: `Model ${HUD.GO}`, menu: 'model' })
  actions.push({ kind: 'submenu', label: `Mode ${HUD.GO}`, menu: 'mode' })
  actions.push({ kind: 'archive', label: 'Archive session' })
  actions.push({ kind: 'back', label: `${HUD.BACK} Back` })
  return actions
}

export interface SubmenuItem {
  label: string
  value: string
  current: boolean
}

/** The Model submenu — current model marked. */
export function modelItems(current: string | null): SubmenuItem[] {
  const items = MODELS.map((m) => ({
    label: `${m.id === current ? `${HUD.CUR} ` : '  '}${m.label}`,
    value: m.id,
    current: m.id === current,
  }))
  items.push({ label: `${HUD.BACK} Back`, value: '', current: false })
  return items
}

/** The Mode submenu — current permission mode marked. */
export function modeItems(current: PermissionMode | string | null): SubmenuItem[] {
  const items: SubmenuItem[] = MODES.map((m) => ({
    label: `${m === current ? `${HUD.CUR} ` : '  '}${m}`,
    value: m,
    current: m === current,
  }))
  items.push({ label: `${HUD.BACK} Back`, value: '', current: false })
  return items
}
