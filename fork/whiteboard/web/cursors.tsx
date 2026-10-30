// Exposes CollaboratorCursors, Zoom Whiteboard's cursor style: a triangle with a name chip beside it, a
// cursor that stops 20px inside the viewport edge with its tip turned toward an off-screen user and its
// chip behind the tip, and a fade after 6s without activity.
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CollaboratorHintOverlayUtil, useEditor, useValue, type Box, type TLInstancePresence } from 'tldraw'

// Replaces tldraw's off-screen triangles, which CollaboratorCursors takes over.
export class NoCollaboratorHint extends CollaboratorHintOverlayUtil {
  override isActive() { return false }
}

export function CollaboratorCursors() {
  const editor = useEditor()
  const collaborators = useValue('collaborator cursors', () => editor.getVisibleCollaboratorsOnCurrentPage(), [editor])
  useValue('cursor camera', () => editor.getCamera(), [editor]) // Subscribe so cursors follow pan and zoom.
  const view = editor.getViewportScreenBounds()
  // Drawn above tldraw's menus, which would hide a cursor stopped at the top edge.
  return createPortal(<div className="wb-cursors" style={{ left: view.x, top: view.y, width: view.w, height: view.h }}>
    {collaborators.map((presence) => presence.cursor && <Cursor key={presence.userId} presence={presence} view={view} />)}
  </div>, document.body)
}

const EDGE = 20, MARGIN = 4
// The name chip's height and, on screen, its offset from the tip; matches .wb-cursor-name.
const CHIP_H = 24, CHIP_X = 14, CHIP_Y = 16
// How far the tip stands out from the chip edge when off screen: the triangle's length plus a gap.
const TIP_OUT = 12

function Cursor({ presence, view }: { presence: TLInstancePresence; view: Box }) {
  const editor = useEditor()
  const chip = useRef<HTMLDivElement>(null)
  const [chipWidth, setChipWidth] = useState(30)
  const name = presence.userName && presence.userName !== 'New User' ? presence.userName : null
  useLayoutEffect(() => setChipWidth(chip.current?.offsetWidth ?? 0), [name])
  const w = name ? chipWidth : 0
  const real = editor.pageToViewport(presence.cursor!)
  // As in Zoom, an off-screen tip stays EDGE inside the viewport.
  let x = Math.min(Math.max(real.x, EDGE), view.w - EDGE), y = Math.min(Math.max(real.y, EDGE), view.h - EDGE)
  let turn = 0, chipX: number, chipY: number
  if (x === real.x && y === real.y) {
    // On screen the chip sits below-right of the tip, flipped where it would leave the viewport.
    chipX = x + CHIP_X + w > view.w - MARGIN ? -CHIP_X - w : CHIP_X
    chipY = y + CHIP_Y + CHIP_H > view.h - MARGIN ? -CHIP_Y - CHIP_H : CHIP_Y
  } else {
    // Off screen the tip points at the real position at any angle (Zoom picks one of four sides), and the
    // chip trails behind it, as in Zoom: the tip stands out from where the line toward the user leaves
    // the chip, a pill of half-length a and radius R.
    const angle = Math.atan2(real.y - y, real.x - x), dx = Math.abs(Math.cos(angle)), dy = Math.abs(Math.sin(angle))
    const R = CHIP_H / 2, a = Math.max(w / 2 - R, 0)
    const out = (!w ? 0 : R * dx <= a * dy ? R / dy : a * dx + Math.sqrt(R * R - a * a * dy * dy)) + TIP_OUT
    chipX = -Math.cos(angle) * out - w / 2
    chipY = -Math.sin(angle) * out - R
    // Keep the chip inside the viewport by moving the whole cursor.
    x += Math.max(MARGIN - (x + chipX), 0) - Math.max(x + chipX + w - (view.w - MARGIN), 0)
    y += Math.max(MARGIN - (y + chipY), 0) - Math.max(y + chipY + CHIP_H - (view.h - MARGIN), 0)
    // The triangle points up-left (-135deg) when not turned.
    turn = angle * 180 / Math.PI + 135
  }
  return <div className="wb-cursor" style={{ transform: `translate(${x}px, ${y}px)` }}>
    {/* Remounting on each activity restarts the fade. */}
    <div key={presence.lastActivityTimestamp} className="wb-cursor-fade">
      <svg className="wb-cursor-arrow" viewBox="0 0 26 26" style={{ transform: `rotate(${turn}deg)` }} aria-hidden="true">
        <path d="M8 5L8 13.5858C8 14.4767 9.07714 14.9229 9.70711 14.2929L18.2929 5.70711C18.9229 5.07714 18.4767 4 17.5858 4L9 4C8.44772 4 8 4.44771 8 5Z" fill={presence.color} />
      </svg>
      {name && <div ref={chip} className="wb-cursor-name" style={{ left: chipX, top: chipY, background: presence.color }}>{name}</div>}
    </div>
  </div>
}
