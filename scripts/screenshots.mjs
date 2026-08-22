// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// The README's screenshots, regenerated from scratch.
//
//   node scripts/screenshots.mjs   ->  docs/screenshots/*.png
//
// Everything in them is invented. The mock engine is rewritten in place -- in a
// throwaway copy, never in `server/` -- to play out one turn that exercises the
// parts worth showing: reasoning, a plan, a shell call, prose with markdown, a
// patch, a table. The servers are two local daemons, and the ssh list comes
// from a fake `~/.ssh/config` in a temp HOME, so nothing here is the author's.
//
// The daemon is put back to the shipping copy before the Servers shot: a
// patched one hashes differently and the row would read "older than this app".
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const { chromium } = require('playwright');
const OUT = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const freePort = () => new Promise(r => { const s = net.createServer().listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));}); });
const up = u => fetch(u).then(()=>true).catch(()=>false);
const wait = async (f, ms=20000) => { const d=Date.now()+ms; while(Date.now()<d){ if(await f()) return true; await new Promise(r=>setTimeout(r,150)); } return false; };

// --- a mock engine that plays out something worth looking at ---------------
const SCRIPT = `    def _run(self, turn_id, text):
        self.emit("session.init", engine="mock", model=self.session.meta.get("model"),
                  native_id=self.session.meta.get("native_id"),
                  cwd=self.session.workdir(), tools=["Bash", "Read", "Edit"])
        time.sleep(0.2)
        self.emit("thinking", block="th1", text=(
            "The bundle grew 40% between v2.3 and v2.4 and nothing in the "
            "changelog explains it, so the place to start is what actually "
            "landed in the output rather than what the diff says. If one "
            "dependency is being pulled in twice it will show up as a "
            "duplicated chunk, which is the cheapest thing to check first."))
        self.emit("todo", items=[
            {"text": "Measure the two builds", "status": "completed"},
            {"text": "Find what grew", "status": "completed"},
            {"text": "Remove the duplicate copy", "status": "in_progress"},
            {"text": "Re-measure and confirm", "status": "pending"}])
        self.emit("tool.start", tool_id="t1", name="Bash",
                  title="du -sh dist/*.js | sort -h | tail -5",
                  input={"command": "du -sh dist/*.js | sort -h | tail -5"})
        time.sleep(0.3)
        self.emit("tool.end", tool_id="t1", is_error=False, exit_code=0, output=(
            " 84K\\tdist/runtime.js\\n"
            "212K\\tdist/vendor-a1c3.js\\n"
            "218K\\tdist/vendor-9f04.js\\n"
            "340K\\tdist/main.js\\n"))
        for chunk in ("Two vendor chunks, near", "ly the same size. ",
                      "\`vendor-9f04\` is a second copy of the date library:"):
            self.emit("text.delta", block="b1", text=chunk)
            time.sleep(0.12)
        self.emit("text", block="b1", text=(
            "Two vendor chunks, nearly the same size. \`vendor-9f04\` is a "
            "second copy of the date library:\\n\\n"
            "- \`@acme/ui\` asks for \`date-fns@^3\`\\n"
            "- \`@acme/charts\` pins \`date-fns@2.30\`\\n\\n"
            "The resolver keeps both, so it ships twice."))
        self.emit("text", block="b1b", text="Pinning both to one version:")
        self.emit("diff", files=[{"path": "package.json", "kind": "edit", "diff": (
            "--- a/package.json\\n+++ b/package.json\\n"
            "@@ -18,6 +18,9 @@\\n"
            "   \\"dependencies\\": {\\n"
            "     \\"@acme/charts\\": \\"^1.4.0\\",\\n"
            "     \\"@acme/ui\\": \\"^2.1.0\\"\\n"
            "+  },\\n"
            "+  \\"overrides\\": {\\n"
            "+    \\"date-fns\\": \\"^3.6.0\\"\\n"
            "   }\\n")}])
        self.emit("text", block="b1c", text="Rebuilding to confirm:")
        self.emit("tool.start", tool_id="t2", name="Bash", title="npm run build",
                  input={"command": "npm run build"})
        time.sleep(0.3)
        self.emit("tool.end", tool_id="t2", is_error=False, exit_code=0,
                  output="built in 11.4s\\n  dist/main.js      340K\\n  dist/vendor-a1c3.js  212K\\n")
        self.emit("todo", items=[
            {"text": "Measure the two builds", "status": "completed"},
            {"text": "Find what grew", "status": "completed"},
            {"text": "Remove the duplicate copy", "status": "completed"},
            {"text": "Re-measure and confirm", "status": "completed"}])
        self.emit("text", block="b2", text=(
            "Fixed. An \`overrides\` entry collapses both requests onto "
            "\`date-fns@3.6\`, and the duplicate chunk is gone:\\n\\n"
            "| | before | after |\\n|---|---|---|\\n"
            "| bundle | 854 KB | 636 KB |\\n\\n"
            "Worth a note in the changelog: anything that needed the v2 API "
            "would now get v3, and the two differ on \`formatDistance\`."))
        self.session.finish_turn(turn_id,
                                 usage={"input_tokens": 1840, "output_tokens": 2130,
                                        "cache_read_tokens": 121400,
                                        "cache_write_tokens": 24800},
                                 context_usage={"input_tokens": 1840,
                                                "output_tokens": 2130,
                                                "cache_read_tokens": 121400,
                                                "cache_write_tokens": 24800},
                                 cost_usd=0.42, duration_ms=94000)
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
const homes = ['a', 'b'].map(n => { const h = path.join(tmp, n); fs.mkdirSync(h, { recursive: true }); return h; });
let src = fs.readFileSync(path.join(ROOT, 'server', 'heartbeat.py'), 'utf8');
const start = src.indexOf('    def _run(self, turn_id, text):');
const end = src.indexOf('\n    def interrupt(self):', start);
if (start < 0 || end < 0) throw new Error('could not find the mock turn to replace');
src = src.slice(0, start) + SCRIPT + src.slice(end + 1);
for (const h of homes) fs.writeFileSync(path.join(h, 'heartbeat.py'), src);

const ports = [await freePort(), await freePort()];
const daemons = homes.map((h, i) => spawn('python3', [path.join(h,'heartbeat.py'),'--foreground','--port',String(ports[i])],
  { cwd: h, env: { ...process.env, CADEN_HOME: h }, stdio: 'ignore' }));
for (const p of ports) await wait(()=>up(`http://127.0.0.1:${p}/v1/ping`));

const names = ['This Mac', 'gpu-01'];
const cfg = { servers: homes.map((h, i) => ({
    id: `srv-${i}`, name: names[i], mode: 'direct',
    directURL: `http://127.0.0.1:${ports[i]}`, tokenFile: path.join(h, 'token'),
    remoteHome: '~/.caden', provisioned: true })),
  providers: [{ id: 'p1', name: 'Anthropic', proto: 'mock', baseURL: '',
    models: [{ id: 'm1', modelID: 'mock-1', alias: 'Opus 5', contextWindow: 800000 }] }],
  models: [], defaultPermissionMode: 'bypassPermissions' };
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));

const fakeHome = path.join(tmp, 'home');
fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.ssh', 'config'), [
  'Host build-box', '  HostName build-box.internal', '',
  'Host gpu-02', '  HostName gpu-02.internal', '',
  'Host sandbox', '  HostName sandbox.internal', ''].join('\n'));

const hport = await freePort();
const host = spawn(process.execPath, [path.join(ROOT,'app','server.js'), String(hport)],
  { cwd: ROOT, env: { ...process.env, HOME: fakeHome, CADEN_CONFIG: cfgPath,
         CADEN_NO_LOCAL_INSTALL: '1' }, stdio: 'ignore' });
await wait(()=>up(`http://127.0.0.1:${hport}/host/config`));

// A few sessions so the sidebar has something to group.
const mk = async (i, title, cwd, msg) => {
  const r = await fetch(`http://127.0.0.1:${hport}/proxy/srv-${i}/v1/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, engine: 'mock', model: 'mock-1', model_label: 'Opus 5',
      provider: { protocol: 'mock' }, cwd, create_cwd: true,
      permission_mode: 'bypassPermissions', context_window: 800000, message: msg }) });
  const j = await r.json();
  if (!j.session) console.log('  create failed:', r.status, JSON.stringify(j).slice(0,160));
  return j.session;
};
fs.mkdirSync(path.join(tmp,'work','web-console'), { recursive: true });
fs.mkdirSync(path.join(tmp,'work','ingest'), { recursive: true });
fs.mkdirSync(path.join(tmp,'work','trainer'), { recursive: true });
await mk(0, '', path.join(tmp,'work','ingest'), 'Add a retry around the S3 upload');
await mk(1, '', path.join(tmp,'work','trainer'), 'Profile the data loader');
const hero = await mk(0, '', path.join(tmp,'work','web-console'),
  'The release build is 40% bigger than last week — find out why and fix it');
await new Promise(r => setTimeout(r, 4000));
for (const i of [0,1]) {
  const r = await fetch(`http://127.0.0.1:${hport}/proxy/srv-${i}/v1/sessions`).then(r=>r.json());
  console.log('srv-'+i, (r.sessions||[]).map(s => [s.title, s.state, s.turns]));
}

const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1360, height: 900 },
  deviceScaleFactor: 2, colorScheme: 'dark' });
await page.goto(`http://127.0.0.1:${hport}`);
await page.waitForSelector('.nav-row', { timeout: 20000 });
await page.locator('.nav-row', { hasText: 'release build' }).first().click();
await page.waitForSelector('text=Fixed.', { timeout: 20000 });
await page.evaluate(() => { const c = document.querySelector('.conversation'); if (c) c.scrollTop = 0; });
const fits = await page.evaluate(() => {
  const c = document.querySelector('.conversation');
  return c ? { scroll: c.scrollHeight, view: c.clientHeight } : null;
});
console.log('transcript height', JSON.stringify(fits));
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: path.join(OUT, 'session.png') });
console.log('wrote docs/screenshots/session.png');

const pristine = fs.readFileSync(path.join(ROOT, 'server', 'heartbeat.py'), 'utf8');
for (let i = 0; i < homes.length; i++) {
  daemons[i].kill();
  fs.writeFileSync(path.join(homes[i], 'heartbeat.py'), pristine);
}
await new Promise(r => setTimeout(r, 800));
const restarted = homes.map((h, i) => spawn('python3',
  [path.join(h,'heartbeat.py'),'--foreground','--port',String(ports[i])],
  { cwd: h, env: { ...process.env, CADEN_HOME: h }, stdio: 'ignore' }));
for (const p of ports) await wait(()=>up(`http://127.0.0.1:${p}/v1/ping`));
daemons.length = 0; daemons.push(...restarted);

await page.locator('.nav-row', { hasText: 'Servers' }).first().click();
await page.waitForSelector('.prov-card', { timeout: 20000 });
await page.waitForFunction(() => !/Checking…/.test(document.body.innerText), null, { timeout: 20000 }).catch(()=>{});
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: path.join(OUT, 'servers.png') });
console.log('wrote docs/screenshots/servers.png');

await b.close();
daemons.forEach(d => d.kill()); host.kill();
fs.rmSync(tmp, { recursive: true, force: true });
