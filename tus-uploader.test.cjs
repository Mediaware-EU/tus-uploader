const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, 'tus-uploader.js'), 'utf8')
const settingsCSS = fs.readFileSync(path.join(__dirname, 'settings.css'), 'utf8')
const endpoint = 'https://ai.mangoirc.chat/tus-test/files/'

function response(status, headers = {}) {
  return new Response(null, { status, headers: { 'Tus-Resumable': '1.0.0', ...headers } })
}

function makeHarness(fetchImplementation, configuration = {}) {
  let providerID
  let handler
  const logs = []
  const storedEndpoint = configuration.endpoint
  const storedToken = configuration.token
  vm.runInNewContext(source, {
    URL,
    Uint8Array,
    TextEncoder,
    btoa,
    fetch: fetchImplementation,
    localStorage: {
      getItem(key) {
        assert.equal(key, 'tus-endpoint')
        return storedEndpoint || null
      }
    },
    console: { info: (message) => logs.push(message) },
    grove: {
      secrets: {
        application: {
          async get(key) {
            assert.equal(key, 'tus-bearer-token')
            return storedToken || null
          }
        }
      },
      uploads: {
        register(id, registeredHandler) {
          providerID = id
          handler = registeredHandler
        }
      }
    }
  })
  return { providerID, handler, logs }
}

function makeFile(size, reads) {
  return {
    name: 'Mango résumé.txt',
    type: 'text/plain',
    size,
    async read(offset, length) {
      reads.push({ offset, length })
      return new Uint8Array(length).fill(0x61)
    }
  }
}

function testSettingsUseInjectedGroveThemeTokens() {
  assert.match(settingsCSS, /var\(--grove-accent,/u)
  assert.doesNotMatch(settingsCSS, /--mango-/u)
}

async function testCreatesAndUploadsInBoundedChunks() {
  const requests = []
  const reads = []
  const progress = []
  const fileSize = 1024 * 1024 + 3
  let serverOffset = 0
  const harness = makeHarness(async (url, options) => {
    requests.push({ url: String(url), options })
    if (options.method === 'POST') {
      return response(201, { Location: 'upload-123' })
    }
    assert.equal(options.method, 'PATCH')
    assert.equal(options.headers['Upload-Offset'], String(serverOffset))
    assert.equal(options.headers['Content-Type'], 'application/offset+octet-stream')
    serverOffset += options.body.byteLength
    return response(204, { 'Upload-Offset': String(serverOffset) })
  })

  assert.equal(harness.providerID, 'tus')
  const result = await harness.handler(makeFile(fileSize, reads), { progress: (fraction) => progress.push(fraction) })

  assert.equal(result.url, `${endpoint}upload-123`)
  assert.equal(requests[0].options.method, 'POST')
  assert.equal(requests[0].options.headers['Upload-Length'], String(fileSize))
  assert.match(requests[0].options.headers['Upload-Metadata'], /^filename [A-Za-z0-9+/=]+,filetype [A-Za-z0-9+/=]+$/u)
  assert.deepEqual(reads, [
    { offset: 0, length: 1024 * 1024 },
    { offset: 1024 * 1024, length: 3 }
  ])
  assert.equal(progress.at(-1), 1)
}

async function testRecoversOffsetAfterAnUncertainPatch() {
  const reads = []
  const methods = []
  let patchCount = 0
  const harness = makeHarness(async (_url, options) => {
    methods.push(options.method)
    if (options.method === 'POST') return response(201, { Location: `${endpoint}upload-recover` })
    if (options.method === 'HEAD') return response(200, { 'Upload-Offset': '4' })
    patchCount += 1
    if (patchCount === 1) throw new Error('connection dropped')
    assert.equal(options.headers['Upload-Offset'], '4')
    assert.equal(options.body.byteLength, 4)
    return response(204, { 'Upload-Offset': '8' })
  })

  const result = await harness.handler(makeFile(8, reads), { progress() {} })

  assert.equal(result.url, `${endpoint}upload-recover`)
  assert.deepEqual(methods, ['POST', 'PATCH', 'HEAD', 'PATCH'])
  assert.deepEqual(reads, [{ offset: 0, length: 8 }, { offset: 4, length: 4 }])
}

async function testRejectsCrossOriginUploadLocation() {
  const harness = makeHarness(async () => response(201, { Location: 'https://files.attacker.example/upload' }))
  await assert.rejects(
    harness.handler(makeFile(1, []), { progress() {} }),
    /outside the configured HTTPS origin/u
  )
}

async function testRejectsUnexpectedServerOffset() {
  const harness = makeHarness(async (_url, options) => {
    if (options.method === 'POST') return response(201, { Location: 'upload-offset' })
    return response(204, { 'Upload-Offset': '2' })
  })
  await assert.rejects(
    harness.handler(makeFile(4, []), { progress() {} }),
    /unexpected upload offset/u
  )
}

async function testUsesConfiguredEndpointPortAndBearerToken() {
  const configuredEndpoint = 'https://uploads.example.test:9443/tus/'
  const requests = []
  let serverOffset = 0
  const harness = makeHarness(async (url, options) => {
    requests.push({ url: String(url), options })
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer secret-token')
    if (options.method === 'POST') return response(201, { Location: 'upload-configured' })
    serverOffset += options.body.byteLength
    return response(204, { 'Upload-Offset': String(serverOffset) })
  }, { endpoint: configuredEndpoint, token: ' secret-token ' })

  const result = await harness.handler(makeFile(2, []), { progress() {} })

  assert.equal(requests[0].url, configuredEndpoint)
  assert.equal(result.url, `${configuredEndpoint}upload-configured`)
}

async function testRejectsInsecureConfiguredEndpointBeforeFetching() {
  let fetched = false
  const harness = makeHarness(async () => {
    fetched = true
    throw new Error('must not fetch')
  }, { endpoint: 'http://uploads.example.test/tus/' })

  await assert.rejects(
    harness.handler(makeFile(1, []), { progress() {} }),
    /must be an HTTPS URL/u
  )
  assert.equal(fetched, false)
}

async function main() {
  testSettingsUseInjectedGroveThemeTokens()
  await testCreatesAndUploadsInBoundedChunks()
  await testRecoversOffsetAfterAnUncertainPatch()
  await testRejectsCrossOriginUploadLocation()
  await testRejectsUnexpectedServerOffset()
  await testUsesConfiguredEndpointPortAndBearerToken()
  await testRejectsInsecureConfiguredEndpointBeforeFetching()
  console.log('TUS Uploader Root tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
