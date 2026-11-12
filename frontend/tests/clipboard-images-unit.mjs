// Pasted images (lib/clipboardImages.js): the files a paste event carries,
// the async clipboard as second way in, and the case the desktop app showed:
// an image is announced but the file never arrives.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imagesFromPaste, imagesFromClipboard, pastedImages } from '../src/lib/clipboardImages.js'

const file = (type = 'image/png') => ({ name: 'image.png', type, size: 10 })
const event = ({ items = [], files = [], types } = {}) => ({ clipboardData: { items, files, types: types || items.map((i) => (i.kind === 'file' ? 'Files' : i.type)) } })
const imageItem = (f) => ({ kind: 'file', type: 'image/png', getAsFile: () => f })
const textItem = { kind: 'string', type: 'text/plain', getAsFile: () => null }
const clipboardWith = (blobType) => ({ read: async () => [{ types: [blobType], getType: async () => new Blob(['x'], { type: blobType }) }] })

test('an image item with its file', () => {
  const f = file()
  assert.deepEqual(imagesFromPaste(event({ items: [imageItem(f)] })), { offered: true, files: [f], empty: false })
})

test('text only: not about an image, the paste goes through', async () => {
  const e = event({ items: [textItem] })
  assert.deepEqual(imagesFromPaste(e), { offered: false, files: [], empty: false })
  assert.equal(await pastedImages(e, { clipboard: clipboardWith('image/png') }), null)
})

test('announced but the file never arrives: the files list, then the async clipboard', async () => {
  const f = file()
  assert.deepEqual(imagesFromPaste(event({ items: [imageItem(null)], files: [f] })).files, [f])
  const viaClipboard = await pastedImages(event({ items: [imageItem(null)] }), { clipboard: clipboardWith('image/png') })
  assert.equal(viaClipboard.length, 1)
  assert.equal(viaClipboard[0].type, 'image/png')
})

test('announced and unreadable everywhere: an empty list, so the caller can say so', async () => {
  assert.deepEqual(await pastedImages(event({ items: [imageItem(null)] }), { clipboard: { read: async () => { throw new Error('denied') } } }), [])
  assert.deepEqual(await pastedImages(event({ items: [imageItem(null)] }), { clipboard: undefined }), [])
})

test('a paste that carries nothing at all still tries the async clipboard, quietly', async () => {
  const empty = event({ items: [], types: [] })
  assert.equal(imagesFromPaste(empty).empty, true)
  assert.equal((await pastedImages(empty, { clipboard: clipboardWith('image/jpeg') }))[0].type, 'image/jpeg')
  assert.equal(await pastedImages(empty, { clipboard: clipboardWith('text/plain') }), null)
})

test('the async clipboard without read support gives nothing', async () => {
  assert.deepEqual(await imagesFromClipboard({}), [])
})
