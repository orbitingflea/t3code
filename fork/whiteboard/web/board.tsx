// Exposes Board, the synced tldraw canvas with math and region-reference support.
import { createContext, useContext, useEffect, useState } from 'react'
import {
  DefaultPeopleMenu,
  DefaultToolbar,
  DefaultToolbarContent,
  Box,
  getUserPreferences,
  inlineBase64AssetStore,
  react,
  setUserPreferences,
  Tldraw,
  ToolbarItem,
  useEditor,
  type TLPageId,
  type TLUiOverrides,
  type TldrawOptions,
} from 'tldraw'
import { useSync } from '@tldraw/sync'
import { getDefaultUserPresence } from '@tldraw/tlschema'
import 'tldraw/tldraw.css'
import 'katex/dist/katex.min.css'
import '@benrbray/prosemirror-math/dist/prosemirror-math.css'
import { mathTextOptions } from './mathtag'
import { onBoardView, type BoardView } from './bridge'
import { markPresence, REGION_TOOL, RefsLayer, RegionTool } from './refs'
import { CollaboratorCursors, NoCollaboratorHint } from './cursors'
import { cameraAt, viewCenter } from './camera'

// Holds the action that brings the chat back while the chat panel is collapsed, else null.
export const ShowChat = createContext<(() => void) | null>(null)

function ChatButton() {
  const showChat = useContext(ShowChat)
  return showChat && <button className="wb-show" onClick={showChat}>
    <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>Chat
  </button>
}

const components = {
  InFrontOfTheCanvas: () => <><RefsLayer /><CollaboratorCursors /></>,
  CollaboratorCursor: null,
  // The people list sits under the Chat button so the top-right corner stays one column wide.
  SharePanel: () => <div className="wb-share"><ChatButton /><DefaultPeopleMenu /></div>,
  Toolbar: () => (
    <DefaultToolbar><ToolbarItem tool={REGION_TOOL} /><DefaultToolbarContent /></DefaultToolbar>
  ),
}
const overrides = { tools: (editor, tools) => ({
  ...tools,
  [REGION_TOOL]: { id: REGION_TOOL, label: 'Reference region', icon: 'tool-frame', onSelect: () => editor.setCurrentTool(REGION_TOOL) },
}) } satisfies TLUiOverrides
const overlayUtils = [NoCollaboratorHint]
const options = { ...mathTextOptions, camera: { wheelBehavior: 'zoom' } } satisfies Partial<TldrawOptions>

declare global { interface Window { wbExport?: Promise<string> } }

function ExportImage() {
  const editor = useEditor()
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const value = params.get('export')!
    const page = params.get('page') as TLPageId | null
    if (page) editor.setCurrentPage(page)
    const region = value.split(',').map(Number)
    const bounds = region.length === 4 ? new Box(region[0]!, region[1]!, region[2]!, region[3]!) : undefined
    window.wbExport = editor.toImageDataUrl(editor.getCurrentPageShapes(), {
      format: 'png', bounds, padding: 0, pixelRatio: 1, background: true, darkMode: false,
    }).then(({ url }) => url)
  }, [editor])
  return null
}

function useKatexFonts() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    void document.fonts.ready
      .then(() => Promise.all([...document.fonts].filter((font) => font.family.startsWith('KaTeX_')).map((font) => font.load())))
      .finally(() => setReady(true))
  }, [])
  return ready
}

// Remembers each board's last view center and zoom in this browser, so every chat session on the same
// board starts where the user left it, without remounting the board.
function CameraMemory({ id }: { id: string }) {
  const editor = useEditor()
  useEffect(() => {
    const key = `wb-view:${id}`
    const saved = localStorage.getItem(key)
    if (saved) {
      const { center, z } = JSON.parse(saved)
      editor.setCamera(cameraAt(center, z, editor.getViewportScreenBounds()))
    }
    let timer: number | undefined
    const stop = react('camera memory', () => {
      const camera = editor.getCamera()
      const view = editor.getViewportScreenBounds()
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        localStorage.setItem(key, JSON.stringify({ center: viewCenter(camera, view), z: camera.z }))
      }, 300)
    })
    return () => { window.clearTimeout(timer); stop() }
  }, [editor, id])
  return null
}

// ?view=fit or ?view=x,y,w,h frames the camera once on mount for direct board views.
function InitialView() {
  const editor = useEditor()
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const view = params.get('view')
    if (!view) return
    // Apply the framing once: a later room switch remounts the board and must keep that room's remembered camera.
    params.delete('view')
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`)
    const region = view.split(',').map(Number)
    if (region.length === 4 && region.every(Number.isFinite)) editor.zoomToBounds({ x: region[0]!, y: region[1]!, w: region[2]!, h: region[3]! }, { inset: 40 })
    else editor.zoomToFit()
  }, [editor])
  return null
}

// tldraw follows the browser language and starts light unless the stored preferences say otherwise;
// start in English and in the system's colour scheme.
const prefs = getUserPreferences()
if (!prefs.locale || !prefs.colorScheme) setUserPreferences({ ...prefs, locale: prefs.locale ?? 'en', colorScheme: prefs.colorScheme ?? 'system' })
// Until the user picks a name in the people menu, show the name on their login's allow entry.
if (!prefs.name) void fetch('/auth/whoami').then((res) => res.ok ? res.json() : null).then((me) => {
  if (me?.name && !getUserPreferences().name) setUserPreferences({ ...getUserPreferences(), name: me.name })
}).catch(() => {})

// Each room's board mounts hidden and is swapped in only once its editor has drawn, so opening the
// page or switching projects never shows a loading screen or a half-built board in between.
export function Board({ exportMode = false }: { exportMode?: boolean }) {
  const fontsReady = useKatexFonts()
  const [{ room, label }, setView] = useState<BoardView>({ room: 'main', session: null, label: null })
  const [shown, setShown] = useState<string | null>(null)
  useEffect(() => onBoardView(setView), [])
  useEffect(() => { document.title = label ? `Board (${label})` : 'Board' }, [label])
  if (!fontsReady) return null
  const rooms = shown && shown !== room ? [shown, room] : [room]
  return <div className="boards">
    {rooms.map((id) => <RoomBoard key={id} room={id} hidden={id !== shown} onReady={setShown} exportMode={exportMode} />)}
  </div>
}

function RoomBoard({ room, hidden, onReady, exportMode }: { room: string; hidden: boolean; onReady: (room: string) => void; exportMode: boolean }) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  const store = useSync({
    uri: `${protocol}://${location.host}/sync/connect/${room}`,
    assets: inlineBase64AssetStore,
    // The export page wb opens for screenshots stays out of the people list; other users see this user's region mark.
    getUserPresence: (store, user) => {
      const presence = exportMode ? null : getDefaultUserPresence(store, user)
      return presence && { ...presence, meta: { mark: markPresence() } }
    },
  })
  useEffect(() => { if (store.status === 'error') onReady(room) }, [store.status, room, onReady])
  const requestedRoom = new URLSearchParams(location.search).get('room')
  return <div className="board" style={{ visibility: hidden ? 'hidden' : 'visible' }}>
    {store.status === 'error' ? <div className="loading">Whiteboard connection failed: {String(store.error)}</div>
      : store.status === 'synced-remote' && <Tldraw store={store.store} tools={[RegionTool]} components={components} overlayUtils={overlayUtils} overrides={overrides} options={options} locale="en" onMount={() => onReady(room)}>
        {exportMode && room === requestedRoom ? <ExportImage /> : <><CameraMemory id={room} /><InitialView /></>}
      </Tldraw>}
  </div>
}
