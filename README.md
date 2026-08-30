# TUS Uploader — a Grove Root

This is the first reference implementation of a Grove upload provider. It is an
application-scoped **Root** with no runtime UI: Mango owns the file picker,
drag-and-drop, paste confirmation, progress state, and composer. Its Grove
settings page configures the service; the Root streams the file to that TUS
endpoint and returns a URL for Mango to add to the draft for review.

The default is Mango's private LAN test service:

```text
https://ai.mangoirc.chat/tus-test/files/
```

That path is reachable only from the home LAN. It is not a public user service
and has no authentication, quotas, retention policy, or deletion UI. For any
other deployment, open **Grove Extensions → TUS Uploader → Settings** and enter
the complete HTTPS creation endpoint, including a custom port or path when
needed. An optional bearer token is stored in this extension's application-wide
Keychain namespace.

The manifest requests `https://*` because the endpoint hostname is chosen by
the user. Grove displays that broad network grant during consent and still
blocks cleartext HTTP. The Root rejects redirects, credentials embedded in the
URL, fragments, and upload locations that leave the configured HTTPS origin.

## Try it

1. Connect the Mac to the same LAN as `macpro`.
2. In Mango's Grove manager, load this directory unpacked.
3. Start **TUS Uploader** and approve file uploads, persistent storage,
   Keychain storage, and access to HTTPS hosts.
4. Use the extension's **Settings** action to change the endpoint or bearer
   token. The defaults already point at the LAN test service.
5. Open Mango's Settings → Uploads. Leave **Automatic** selected (this provider is
   classified as `userConfigured`) or explicitly choose **TUS**.
6. Pick or drop a file in a conversation. Mango selects the file, the Root
   streams it with TUS, and the returned HTTPS URL appears in the composer. IRC
   sees only that ordinary URL after the user sends it.

No Ergo changes are involved. Upload transport and storage are entirely between
the Mango client, the Root, and `tusd`.

## Protocol behavior

- `POST` creates an upload with TUS 1.0, `Upload-Length`, and base64 filename /
  MIME metadata.
- The optional bearer token is sent on `POST`, `PATCH`, and recovery `HEAD`
  requests; redirect following is disabled so credentials cannot cross origins.
- `PATCH` streams at most 1 MiB per native file read.
- A failed/ambiguous `PATCH` or offset conflict uses `HEAD` to recover the
  authoritative `Upload-Offset`, then resumes from that byte.
- Every response must confirm `Tus-Resumable: 1.0.0`; offsets and the final
  upload location are validated before use.
- The returned location must remain on the configured HTTPS origin.

The TUS protocol defines the upload resource, not a universal public download
URL. This test deployment uses `tusd`, where the upload resource is also
fetchable. A production provider for a different service should return the
service's actual share URL after its upload finishes.

## Test

```bash
node Examples/grove-tus-uploader-root/tus-uploader.test.cjs
```

From the home LAN, exercise the actual Root handler against the configured
HTTPS `tusd` service (the test verifies the download and deletes its upload):

```bash
MANGO_TUS_LIVE_TEST=1 node Examples/grove-tus-uploader-root/tus-uploader.live-test.cjs
```

## Test deployment

`macpro` runs `ghcr.io/tus/tusd:v2.10.0` as `mango-tusd-test`, bound only to
`192.168.1.66:8098`. Its persistent Docker volume is
`mango-tusd-test-data`. Nginx terminates the trusted `ai.mangoirc.chat`
certificate and proxies `/tus-test/` without request buffering; that location
allows only loopback and `192.168.1.0/24`. Public DNS has no record for the
hostname, so the service is private even before the nginx address gate.
