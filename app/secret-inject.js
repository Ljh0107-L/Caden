// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Provider-key injection for the daemon proxy.
//
// The renderer never holds a model API key: it sends `key_ref` (a provider
// id) on the two requests that carry a credential -- session create and the
// provider switch -- and the proxy swaps in the real value from the keychain
// before forwarding, the same way it injects the daemon token. Everything
// else passes through untouched.
'use strict';

/// Requests that may carry a provider credential. Session create is
/// `POST /v1/sessions`; the provider switch is `PATCH /v1/sessions/<id>`.
/// The other session sub-routes (messages, interrupt, stop, events) never
/// carry one.
function keyRoute(method, pathname) {
  if (method === 'POST' && pathname === '/v1/sessions') return true;
  if (method === 'PATCH' && /^\/v1\/sessions\/[^/]+$/.test(pathname)) return true;
  return false;
}

/// Mutates and returns `body`: strips the client-side `key_ref` and, when
/// `lookup` has a key for it, writes it into `provider.api_key` -- exactly
/// where the daemon's require_credential looks. A ref the keychain has no
/// key for is still stripped, and the request goes on to fail at the daemon
/// with its own clear "no API key" error rather than here.
function injectProviderKey(body, lookup) {
  if (!body || typeof body !== 'object') return body;
  const ref = body.key_ref;
  if (!ref) return body;
  delete body.key_ref;
  const key = lookup(ref);
  if (key) {
    body.provider = Object.assign({}, body.provider, { api_key: key });
  }
  return body;
}

module.exports = { keyRoute, injectProviderKey };
