const DEFAULT_TUS_ENDPOINT = 'https://ai.mangoirc.chat/tus-test/files/'
const ENDPOINT_STORAGE_KEY = 'tus-endpoint'
const TOKEN_SECRET_KEY = 'tus-bearer-token'

const form = document.querySelector('#settings-form')
const endpointInput = document.querySelector('#endpoint')
const tokenInput = document.querySelector('#token')
const revealButton = document.querySelector('#reveal-token')
const resetButton = document.querySelector('#reset')
const status = document.querySelector('#status')

endpointInput.value = localStorage.getItem(ENDPOINT_STORAGE_KEY) || DEFAULT_TUS_ENDPOINT
loadToken()

revealButton.addEventListener('click', () => {
  const showing = tokenInput.type === 'text'
  tokenInput.type = showing ? 'password' : 'text'
  revealButton.textContent = showing ? 'Show' : 'Hide'
  revealButton.setAttribute('aria-label', showing ? 'Show bearer token' : 'Hide bearer token')
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  setBusy(true)
  try {
    const endpoint = validateEndpoint(endpointInput.value.trim())
    const token = tokenInput.value.trim()
    if (/\r|\n/u.test(token)) throw new Error('The bearer token cannot contain line breaks.')
    if (token) await grove.secrets.application.set(TOKEN_SECRET_KEY, token)
    else await grove.secrets.application.delete(TOKEN_SECRET_KEY)
    localStorage.setItem(ENDPOINT_STORAGE_KEY, endpoint)
    endpointInput.value = endpoint
    report('Settings saved. New uploads use them immediately.')
  } catch (error) {
    report(error instanceof Error ? error.message : 'The settings could not be saved.')
    grove.log(`Could not save TUS settings: ${String(error)}`)
  } finally {
    setBusy(false)
  }
})

resetButton.addEventListener('click', async () => {
  setBusy(true)
  try {
    await grove.secrets.application.delete(TOKEN_SECRET_KEY)
    localStorage.removeItem(ENDPOINT_STORAGE_KEY)
    endpointInput.value = DEFAULT_TUS_ENDPOINT
    tokenInput.value = ''
    report('Using Mango’s LAN test server without authentication.')
  } catch (error) {
    report('The saved token could not be removed.')
    grove.log(`Could not reset TUS settings: ${String(error)}`)
  } finally {
    setBusy(false)
  }
})

async function loadToken() {
  try {
    tokenInput.value = (await grove.secrets.application.get(TOKEN_SECRET_KEY)) || ''
  } catch (error) {
    report('The saved bearer token could not be loaded.')
    grove.log(`Could not load the TUS bearer token: ${String(error)}`)
  }
}

function validateEndpoint(value) {
  let endpoint
  try {
    endpoint = new URL(value)
  } catch {
    throw new Error('Enter a valid endpoint URL.')
  }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('The endpoint must use HTTPS and cannot contain credentials or a fragment.')
  }
  return endpoint.toString()
}

function setBusy(busy) {
  for (const control of form.elements) control.disabled = busy
}

function report(message) {
  status.textContent = message
}
