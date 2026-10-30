// Pure camera arithmetic for the board panel, kept separate from tldraw's editor API so it can be unit-tested.

type Point = { x: number; y: number }
type Camera = { x: number; y: number; z: number }
type ViewSize = { w: number; h: number }
type Region = { x: number; y: number; w: number; h: number }

// The camera that puts page point `center` at the panel's center, at zoom `z`.
export function cameraAt(center: Point, z: number, view: ViewSize): Camera {
  return { x: view.w / 2 / z - center.x, y: view.h / 2 / z - center.y, z }
}

// The page point currently at the panel's center, given the camera.
export function viewCenter(camera: Camera, view: ViewSize): Point {
  return { x: view.w / 2 / camera.z - camera.x, y: view.h / 2 / camera.z - camera.y }
}

// Camera that centers `region` in the panel at 100%, or zoomed out just enough to fit it with `inset`
// padding on each side.
export function cameraForRegion(region: Region, view: ViewSize, inset: number): Camera {
  const fitZoom = Math.min((view.w - 2 * inset) / region.w, (view.h - 2 * inset) / region.h)
  const z = Math.min(fitZoom, 1)
  const center = { x: region.x + region.w / 2, y: region.y + region.h / 2 }
  return cameraAt(center, z, view)
}
