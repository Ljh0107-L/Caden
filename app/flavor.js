// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Which installation this process belongs to.
//
// Caden can be installed twice on one Mac: the app you use every day, and a
// development build beside it. The two have to share nothing -- separate
// config, separate keychain items, separate local ports, and a separate daemon
// home on every server -- because the whole point of the second one is to run
// code that is not trusted yet against the same machines the first one is in
// the middle of working on.
//
// Every path that used to be a literal is derived from here. `prod` reproduces
// those literals exactly rather than deriving them from the flavor's name:
// `~/.caden`, `Application Support/Caden` and `app.caden.secrets` are where
// every install already keeps its things, and a tidier scheme would stand every
// one of them up empty.
//
// The default is `dev`, not `prod`. A build declares itself by carrying a
// flavor.json that scripts/build-app.sh writes into the bundle; a source
// checkout carries none, so `npm start` is always the development install.
// That direction is the point: forgetting to declare a flavor should leave you
// talking to the install with nothing in it, never to the one holding your
// work.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const under = (...parts) => path.join(os.homedir(), ...parts);

const FLAVORS = {
  prod: {
    id: 'prod',
    label: 'Caden',
    bundleId: 'app.caden.desktop',
    icon: 'icon.png',
    support: under('Library', 'Application Support', 'Caden'),
    // Short on purpose: %C is a 40-char hash and ssh appends a ~17-char
    // suffix, against a ~104-byte ceiling on unix socket paths.
    controlDir: under('.caden-ssh'),
    keychainService: 'app.caden.secrets',
    defaultPort: 7838,
    remoteHome: '~/.caden',
  },
  dev: {
    id: 'dev',
    label: 'Caden Dev',
    // A different identifier, not just a different name: macOS files an app
    // under its bundle identifier, so sharing one would give the two builds a
    // single Dock tile, one set of granted permissions, and one Gatekeeper
    // verdict between them.
    bundleId: 'app.caden.dev',
    icon: 'icon-dev.png',
    support: under('Library', 'Application Support', 'Caden Dev'),
    controlDir: under('.caden-dev-ssh'),
    keychainService: 'app.caden.dev.secrets',
    // A hundred clear of production's, because neither install can see the
    // other's forwards: each picks a free local port by walking up from its own
    // base while consulting only the servers in its own config, so the bases
    // have to be far enough apart that the walk never reaches the other's.
    defaultPort: 7938,
    // A sibling of `~/.caden`, never `~/.caden/dev`. The daemon treats its home
    // as its own: it reports disk usage across the whole tree and creates and
    // clears directories inside it, so a nested development home would be
    // counted as part of production's, and eventually swept with it.
    remoteHome: '~/.caden-dev',
  },
};

function resolve() {
  const named = process.env.CADEN_FLAVOR;
  if (named) {
    if (!FLAVORS[named]) {
      throw new Error(`CADEN_FLAVOR=${named} is not a flavor (expected `
                      + `${Object.keys(FLAVORS).join(' or ')})`);
    }
    return FLAVORS[named];
  }
  try {
    const declared = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'flavor.json'), 'utf8'));
    if (FLAVORS[declared.id]) return FLAVORS[declared.id];
  } catch {
    // No flavor.json, or an unreadable one: a source checkout, which is
    // development by definition.
  }
  return FLAVORS.dev;
}

// A copy, not the table entry itself: hanging `all` off the resolved flavor
// would make it a member of the table it points at, and the cycle turns
// anything that serialises the flavor -- a test, a log line -- into a throw.
module.exports = { ...resolve(), all: FLAVORS };
