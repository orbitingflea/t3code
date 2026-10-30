// Embeds the isolated T3 chat and bridges board references, highlights, and the split layout.
import { useEffect, useRef, type JSX } from 'react'
import { highlightRegion, hoverRegion, onRefToChat, setBoardRoom } from './bridge'

export function ChatSlot({ boardHidden, showBoard }: { boardHidden: boolean; showBoard: () => void }): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    // The chat shows its Board button only while the board panel is collapsed.
    const postLayout = () => iframeRef.current?.contentWindow?.postMessage({ type: 'wb-layout', boardHidden }, location.origin)
    postLayout()
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== location.origin || event.source !== iframeRef.current?.contentWindow) return
      const { type, path, session, ref, rect } = event.data as
        { type: string; path?: string; session?: string | null; ref?: string | null; rect?: DOMRect }
      if (type === 'wb-project') setBoardRoom(path!, session)
      if (type === 'wb-highlight') highlightRegion(ref!)
      if (type === 'wb-layout-get') postLayout()
      if (type === 'wb-show-board') showBoard()
      if (type === 'wb-hover') {
        // The chat reports the chip's position inside the iframe; the board draws in page coordinates.
        const frame = iframeRef.current?.getBoundingClientRect()
        if (ref && rect && frame) hoverRegion(ref, {
          x: frame.left + rect.x,
          y: frame.top + rect.y + rect.height / 2,
        })
        else hoverRegion(null)
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [boardHidden, showBoard])

  return <section className="chat-slot">
    <iframe
      ref={iframeRef}
      src="/chat/"
      onLoad={() => onRefToChat((ref) => iframeRef.current?.contentWindow?.postMessage({ type: 'wb-insert-ref', ref }, location.origin))}
      title="T3 Code chat"
    />
  </section>
}
