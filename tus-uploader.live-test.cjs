const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

if (process.env.MANGO_TUS_LIVE_TEST !== '1') {
  console.log('TUS Uploader live test skipped; set MANGO_TUS_LIVE_TEST=1 on the home LAN to run it')
  process.exit(0)
}

const source = fs.readFileSync(path.join(__dirname, 'tus-uploader.js'), 'utf8')
let uploadHandler
vm.runInNewContext(source, {
  URL,
  Uint8Array,
  TextEncoder,
  btoa,
  fetch,
  localStorage: { getItem: () => null },
  console,
  grove: {
    secrets: { application: { get: async () => null } },
    uploads: {
      register(providerID, handler) {
        assert.equal(providerID, 'tus')
        uploadHandler = handler
      }
    }
  }
})

const payload = new TextEncoder().encode(`Mango Grove TUS live test ${new Date().toISOString()}\n`)
const file = {
  name: 'mango-grove-tus-live-test.txt',
  type: 'text/plain',
  size: payload.byteLength,
  async read(offset, length) {
    return payload.slice(offset, offset + length)
  }
}

async function main() {
  assert.equal(typeof uploadHandler, 'function')
  let uploadURL
  try {
    const result = await uploadHandler(file, { progress() {} })
    uploadURL = result.url
    const download = await fetch(uploadURL)
    assert.equal(download.status, 200)
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), payload)
    console.log(`TUS Uploader live flow passed through ${new URL(uploadURL).origin}`)
  } finally {
    if (uploadURL) {
      const cleanup = await fetch(uploadURL, { method: 'DELETE', headers: { 'Tus-Resumable': '1.0.0' } })
      assert.equal(cleanup.status, 204)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
