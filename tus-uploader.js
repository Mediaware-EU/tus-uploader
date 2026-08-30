/*
 * TUS Uploader — an application-scoped Grove Root with no UI.
 *
 * Mango owns file selection and the security-scoped local URL. This Root sees
 * immutable metadata plus bounded reads, streams those chunks with TUS 1.0,
 * and returns the upload resource URL for Mango to insert into the composer.
 */

const DEFAULT_TUS_ENDPOINT = 'https://ai.mangoirc.chat/tus-test/files/'
const ENDPOINT_STORAGE_KEY = 'tus-endpoint'
const TOKEN_SECRET_KEY = 'tus-bearer-token'
const TUS_VERSION = '1.0.0'
const CHUNK_SIZE = 1024 * 1024
const MAX_OFFSET_RECOVERIES = 3

grove.uploads.register('tus', uploadWithTus)
console.info('TUS Uploader ready')

async function uploadWithTus(file, context) {
  validateFile(file)
  const configuration = await loadConfiguration()
  const uploadURL = await createUpload(file, configuration)
  let offset = 0
  let recoveries = 0

  while (offset < file.size) {
    const length = Math.min(CHUNK_SIZE, file.size - offset)
    const chunk = await file.read(offset, length)
    if (!(chunk instanceof Uint8Array) || chunk.byteLength !== length) {
      throw new Error('Mango returned an invalid file chunk.')
    }

    const result = await appendChunk(uploadURL, file.size, offset, chunk, configuration)
    offset = result.offset
    recoveries = result.recovered ? recoveries + 1 : 0
    if (recoveries > MAX_OFFSET_RECOVERIES) {
      throw new Error('The TUS upload could not make progress after recovering its offset.')
    }
    context.progress(file.size === 0 ? 1 : offset / file.size)
  }

  context.progress(1)
  return { url: uploadURL }
}

function validateFile(file) {
  if (!file || typeof file.name !== 'string' || typeof file.type !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.read !== 'function') {
    throw new Error('Mango supplied invalid file metadata.')
  }
}

async function loadConfiguration() {
  const storedEndpoint = localStorage.getItem(ENDPOINT_STORAGE_KEY)
  const endpoint = validateEndpoint(storedEndpoint || DEFAULT_TUS_ENDPOINT)
  const storedToken = await grove.secrets.application.get(TOKEN_SECRET_KEY)
  const token = typeof storedToken === 'string' ? storedToken.trim() : ''
  if (/\r|\n/u.test(token)) throw new Error('The configured bearer token contains an invalid line break.')
  return { endpoint, token }
}

function validateEndpoint(value) {
  let endpoint
  try {
    endpoint = new URL(value)
  } catch (error) {
    throw new Error(`The configured TUS endpoint is not a valid URL (${error}).`)
  }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('The configured TUS endpoint must be an HTTPS URL without credentials or a fragment.')
  }
  return endpoint.toString()
}

function tusHeaders(configuration, headers) {
  if (!configuration.token) return headers
  return { ...headers, Authorization: `Bearer ${configuration.token}` }
}

async function createUpload(file, configuration) {
  const response = await fetch(configuration.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: tusHeaders(configuration, {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(file.size),
      'Upload-Metadata': `filename ${encodeMetadata(file.name)},filetype ${encodeMetadata(file.type)}`
    })
  })
  validateTusVersion(response)
  if (response.status !== 201) {
    throw new Error(`TUS creation failed with HTTP ${response.status}.`)
  }
  const location = response.headers.get('Location')
  if (!location) throw new Error('The TUS server did not return an upload location.')
  const resolved = new URL(location, configuration.endpoint)
  if (resolved.protocol !== 'https:' || resolved.origin !== new URL(configuration.endpoint).origin) {
    throw new Error('The TUS server returned an upload location outside the configured HTTPS origin.')
  }
  return resolved.toString()
}

async function appendChunk(uploadURL, fileSize, offset, chunk, configuration) {
  let response
  try {
    response = await fetch(uploadURL, {
      method: 'PATCH',
      redirect: 'error',
      headers: tusHeaders(configuration, {
        'Tus-Resumable': TUS_VERSION,
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream'
      }),
      body: chunk
    })
  } catch (patchError) {
    return recoverOffset(uploadURL, fileSize, offset, chunk.byteLength, patchError, configuration)
  }

  if (response.status === 409) {
    return recoverOffset(uploadURL, fileSize, offset, chunk.byteLength, new Error('The TUS server reported an offset conflict.'), configuration)
  }
  validateTusVersion(response)
  if (response.status !== 204) {
    throw new Error(`TUS chunk upload failed with HTTP ${response.status}.`)
  }
  const nextOffset = parseOffset(response, fileSize)
  if (nextOffset !== offset + chunk.byteLength) {
    throw new Error('The TUS server returned an unexpected upload offset.')
  }
  return { offset: nextOffset, recovered: false }
}

async function recoverOffset(uploadURL, fileSize, attemptedOffset, attemptedLength, patchError, configuration) {
  let response
  try {
    response = await fetch(uploadURL, {
      method: 'HEAD',
      redirect: 'error',
      headers: tusHeaders(configuration, { 'Tus-Resumable': TUS_VERSION })
    })
  } catch (headError) {
    throw new Error(`TUS PATCH failed (${patchError}); offset recovery also failed (${headError}).`)
  }
  validateTusVersion(response)
  if (response.status !== 200 && response.status !== 204) {
    throw new Error(`TUS offset recovery failed with HTTP ${response.status}.`)
  }
  const recoveredOffset = parseOffset(response, fileSize)
  if (recoveredOffset < attemptedOffset || recoveredOffset > attemptedOffset + attemptedLength) {
    throw new Error('The TUS server recovered an offset outside the attempted chunk.')
  }
  return { offset: recoveredOffset, recovered: true }
}

function parseOffset(response, fileSize) {
  const rawOffset = response.headers.get('Upload-Offset')
  if (!rawOffset || !/^\d+$/u.test(rawOffset)) {
    throw new Error('The TUS server did not return a valid upload offset.')
  }
  const offset = Number(rawOffset)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > fileSize) {
    throw new Error('The TUS server returned an upload offset outside the file.')
  }
  return offset
}

function validateTusVersion(response) {
  if (response.headers.get('Tus-Resumable') !== TUS_VERSION) {
    throw new Error('The server did not confirm TUS 1.0 support.')
  }
}

function encodeMetadata(value) {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
