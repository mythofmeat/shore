# Local OAuth test certificate

This self-signed certificate and its public test-only private key belong to
Shore's isolated OAuth fixture. They contain no production credentials.

The fixture terminates HTTPS requests for `platform.claude.com` and
`api.anthropic.com` locally, allowing the installed Claude Code SDK to exercise
its normal token-refresh path without contacting Anthropic. Only the fixture's
SDK subprocess trusts this certificate through `NODE_EXTRA_CA_CERTS`.

The certificate expires in 2126. To replace it:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 36500 \
  -keyout key.pem -out cert.pem \
  -subj '/CN=Shore OAuth test fixture' \
  -addext 'subjectAltName=DNS:platform.claude.com,DNS:api.anthropic.com'
```
