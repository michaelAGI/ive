// Images pasted from the clipboard (a screenshot, a copied picture).
//
// A paste event lists an image as a file item. In the desktop app the item
// can be listed while the file itself never arrives (`getAsFile()` is null):
// the paste then did nothing at all, without a word. So every paste handler
// goes through here: take the files the event has, fall back to the async
// clipboard, and tell the user when the image still did not come through.

const isImageType = (type) => String(type || '').startsWith('image/')

/**
 * What a paste event carries, read synchronously (the event's data is gone
 * after the first await).
 *   offered: the clipboard announced an image
 *   files:   the image files that actually arrived
 *   empty:   the event carried nothing at all (no text, no files)
 */
export function imagesFromPaste(event) {
  const data = event?.clipboardData
  if (!data) return { offered: false, files: [], empty: true }
  const items = Array.from(data.items || [])
  const imageItems = items.filter((item) => isImageType(item.type))
  let files = imageItems.map((item) => { try { return item.getAsFile() } catch { return null } }).filter(Boolean)
  if (!files.length) files = Array.from(data.files || []).filter((file) => isImageType(file.type))
  const types = Array.from(data.types || [])
  return { offered: imageItems.length > 0 || files.length > 0, files, empty: items.length === 0 && types.length === 0 }
}

/**
 * Second way in: the async clipboard API. WebKit shows a small "Paste" button
 * the user confirms; a refusal or an unsupported browser gives an empty list.
 */
export async function imagesFromClipboard(clipboard = globalThis.navigator?.clipboard) {
  if (!clipboard?.read) return []
  try {
    const files = []
    for (const entry of await clipboard.read()) {
      const type = entry.types.find(isImageType)
      if (!type) continue
      const blob = await entry.getType(type)
      files.push(new File([blob], `image.${type.split('/')[1] || 'png'}`, { type }))
    }
    return files
  } catch {
    return []
  }
}

/**
 * The images of a paste, or null when the paste is not about an image and the
 * caller should let it through (text). An empty list means: an image was
 * announced and could not be read; show PASTE_IMAGE_FAILED.
 */
export async function pastedImages(event, { clipboard } = {}) {
  const pasted = imagesFromPaste(event)
  if (pasted.files.length) return pasted.files
  if (!pasted.offered && !pasted.empty) return null
  const viaClipboard = await imagesFromClipboard(clipboard)
  if (viaClipboard.length) return viaClipboard
  return pasted.offered ? [] : null
}

export const PASTE_IMAGE_FAILED = 'The image on the clipboard did not reach IVE. Drag the file into the window instead.'
