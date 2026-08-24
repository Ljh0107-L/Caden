#!/usr/bin/env node
// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// The reverse-proxy half of reaching Caden from a phone, written out for you.
//
//   scripts/web-gateway.cjs caden.example.net [--on <host>] [--only <host>]...
//
// `--on` names a server that *is* the gateway. Its daemon is already on the
// loopback nginx will be talking to, so it needs no tunnel and gets none --
// which is the whole of the simplest useful deployment: one machine, running
// the daemon and the proxy in front of it.
//
// Everything this prints could be typed by hand. The reason not to is the
// tokens: each server has its own, they are 44 characters of base64, and the
// nginx block needs them copied in exactly. Getting one wrong gives a 401 from
// a daemon that is running fine, which is a bad half hour.
//
// Nothing is applied. It prints; you read it, then paste it.
'use strict';

const path = require('path');
const { readConfig, daemonToken } = require('../app/host');

const args = process.argv.slice(2);
let hostname = '';
let onHost = '';
const only = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--flavor') { i++; continue; }   // read by app/flavor via env
  if (args[i] === '--on') { onHost = args[++i] || ''; continue; }
  if (args[i] === '--only') { only.push(args[++i] || ''); continue; }
  if (args[i].startsWith('-')) continue;
  hostname = hostname || args[i];
}
if (!hostname) {
  console.error('usage: scripts/web-gateway.cjs <hostname> [--flavor dev]');
  console.error('  e.g. scripts/web-gateway.cjs caden.example.net');
  process.exit(2);
}

/// A daemon on this Mac's own loopback is the one server this arrangement
/// cannot use: the whole point of a gateway is that the Mac is switched off.
const isLocal = s => {
  if (s.sshHost) return false;
  try { return /^(127\.|localhost$|\[?::1)/.test(new URL(s.directURL).hostname); }
  catch { return false; }
};

const cfg = readConfig();
const all = (cfg.servers || []).filter(s => s.provisioned);
const local = all.filter(isLocal);
// `--only` is for standing one server up first. A route to a tunnel nobody
// has opened yet is a row that reads as broken, which is a poor first
// impression of something that works.
const wanted = s => !only.length || only.includes(s.name) || only.includes(s.sshHost);
const servers = all.filter(s => !isLocal(s) && wanted(s));
if (!servers.length) {
  console.error('no provisioned servers this gateway could reach.');
  console.error(local.length
    ? `  (${local.map(s => s.name || s.id).join(', ')} runs on this Mac, which `
      + 'is the machine a gateway exists to do without.)'
    : '  set one up first.');
  process.exit(1);
}

// One loopback port on the gateway per server. The number itself does not
// matter; that they are stable does, because the systemd unit on each server
// and the nginx block on the gateway have to agree on it.
let next = 7901;
const plan = servers.map(s => {
  // The gateway's own daemon is already on the loopback nginx will use, so it
  // takes its real port and no tunnel. Everything else gets one of these.
  const here = onHost && (s.sshHost === onHost || s.name === onHost);
  return {
    id: s.id,
    name: s.name || s.sshHost || s.id,
    here,
    port: here ? (s.remotePort || 7838) : next++,
    remotePort: s.remotePort || 7838,
    token: daemonToken(s),
  };
});

const missing = plan.filter(p => !p.token);
const usable = plan.filter(p => p.token);

const say = (...l) => console.log(l.join('\n'));

say('# ╔══════════════════════════════════════════════════════════════════╗',
    '# ║  This output contains daemon tokens in clear. They are what the  ║',
    '# ║  proxy injects, so they have to be here -- but do not paste it   ║',
    '# ║  into a ticket, a chat, or anywhere it will be kept.             ║',
    '# ╚══════════════════════════════════════════════════════════════════╝',
    '');

say('# ─── 1. On the gateway: /etc/nginx/sites-available/' + hostname,
    '#',
    '# Get a certificate first, or certbot will rewrite this file for you:',
    `#   certbot --nginx -d ${hostname}`,
    '#',
    '# And a password. Generate it, do not invent it -- this is the only door:',
    `#   htpasswd -B -c /etc/nginx/${hostname}.htpasswd you`,
    '');

say('server {');
say(`    server_name ${hostname};`);
say('');
say('    auth_basic           "Caden";');
say(`    auth_basic_user_file /etc/nginx/${hostname}.htpasswd;`);
say('');
say('    # The console itself. app/web, copied up by the rsync in step 3.');
say('    location / {');
say('        root /srv/caden-web;');
say('        try_files $uri /index.html;');
say('        add_header Cache-Control "no-cache" always;');
say('    }');
for (const p of usable) {
  say('');
  say(p.here
    ? `    # ${p.name} -- the daemon on this machine, no tunnel involved.`
    : `    # ${p.name} -- reached through the tunnel it opens in step 2.`);
  say(`    location /proxy/${p.id}/ {`);
  say(`        proxy_pass http://127.0.0.1:${p.port}/;`);
  say(`        proxy_set_header Authorization "Bearer ${p.token}";`);
  say('        proxy_http_version 1.1;');
  say('        proxy_set_header Connection "";');
  say('        # Caden is an event stream. nginx buffers responses by default,');
  say('        # and a buffered stream does not fail -- it hangs, and the');
  say('        # console looks like the daemon died. These two lines are the');
  say('        # difference between working and mystifying.');
  say('        proxy_buffering off;');
  say('        proxy_read_timeout 3600s;');
  say('        client_max_body_size 64m;   # attachments are capped at 50');
  say('    }');
}
say('}');

const tunnelled = usable.filter(p => !p.here);
if (!tunnelled.length) {
  say('', '# ─── 2. No tunnels needed',
      '#',
      '# Every daemon in this plan is on the gateway itself.');
}
if (tunnelled.length) say('',
    '# ─── 2. On each server: a tunnel it opens itself',
    '#',
    '# Outward, not inward. The gateway never connects to these machines, so',
    '# none of them needs a public address or a hole in a firewall -- and the',
    '# gateway needs no key for them. ssh -R binds the far end on 127.0.0.1,',
    '# so nothing but nginx can reach the forwarded port.',
    '');
for (const p of tunnelled) {
  say(`# ${p.name}: /etc/systemd/system/caden-tunnel.service`);
  say('[Unit]');
  say('Description=Caden tunnel to the web gateway');
  say('After=network-online.target');
  say('');
  say('[Service]');
  say(`ExecStart=/usr/bin/ssh -N -T \\`);
  say('    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \\');
  say(`    -R ${p.port}:127.0.0.1:${p.remotePort} <you>@${hostname}`);
  say('Restart=always');
  say('RestartSec=5');
  say('');
  say('[Install]');
  say('WantedBy=multi-user.target');
  say('');
}

say('# ─── 3. The console files, and the list of servers it should show',
    '#',
    `#   rsync -a --delete app/web/ <you>@${hostname}:/srv/caden-web/`,
    '#',
    '# Then /srv/caden-web/host/config -- a plain file, because there is no',
    '# host process behind this deployment to generate one. It declares no',
    '# capabilities, which is how the console knows to stop offering the',
    '# things only the Mac app can do.',
    '');
const hostConfig = {
  servers: usable.map(p => ({ id: p.id, name: p.name, mode: 'direct',
                              provisioned: true })),
  models: cfg.models || [],
  providers: (cfg.providers || []).map(({ apiKey, ...rest }) => ({ ...rest, hasKey: true })),
  defaults: {
    workdir: cfg.defaultWorkdir || '~',
    permissionMode: cfg.defaultPermissionMode || 'bypassPermissions',
  },
  capabilities: {},
};
say(JSON.stringify(hostConfig, null, 2));

if (missing.length) {
  say('', '# ─── Left out');
  for (const p of missing) {
    say(`#   ${p.name} — no daemon token on this Mac, so nothing to inject.`);
  }
  say('#   Provision them, then run this again.');
}

if (local.length) {
  say('', '# ─── Not included');
  for (const s of local) {
    say(`#   ${s.name || s.id} — its daemon runs on this Mac, and a gateway is`);
    say('#   what you set up so the Mac can be closed.');
  }
}

say('',
    '# ─── Before you finish',
    '#',
    '# The keys. Session creation sends a provider id, not a key, and nothing',
    '# in front of a daemon can turn one into the other on the way past -- a',
    '# proxy adds headers, it does not rewrite JSON. So each daemon resolves',
    '# it from the providers.json provisioning left in its own home. If you',
    '# have rotated a key since, re-provision that server, or the console will',
    '# reach a model holding a credential that no longer works.');
