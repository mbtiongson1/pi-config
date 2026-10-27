import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const fs = require('node:fs');

const actualHome = os.homedir();
const repo = process.env.PI_RECOVERY_PROBE_REPO || fileURLToPath(new URL('../', import.meta.url));
const stock = process.env.PI_TEST_NATIVE_ROOT || path.join(actualHome,'.pi/agent/npm/node_modules/@parke.dev/pi-subagent');
const sdk = process.env.PI_TEST_SDK_ROOT || path.join(actualHome,'.pi/agent/install/releases/1.4.0');
test('actual Android native process safety (not SDK lifecycle proof)', {
 skip: process.platform !== 'android' || !fs.existsSync(path.join(stock,'package.json')) || !fs.existsSync(path.join(sdk,'node_modules/jiti/lib/jiti.cjs')),
 timeout: 60000,
}, async () => {
 const environment = {...process.env};
 try { await probe(actualHome); }
 finally {
  for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
  for (const [key,value] of Object.entries(environment)) process.env[key]=value;
 }
});
async function probe(realHome) {
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-process-safety-'));
fs.chmodSync(out, 0o700);
const sandbox = path.join(out, 'sandbox');
fs.mkdirSync(sandbox, { mode: 0o700 });
process.env.HOME = sandbox;
process.env.PI_CODING_AGENT_DIR = path.join(sandbox, 'agent');
process.env.PI_DURABLE_DIR = path.join(sandbox, 'durable');
process.env.PI_SUBAGENT_LOCK_DIR = path.join(sandbox, 'locks');
process.env.PI_SUBAGENT_SESSION_DIR = path.join(sandbox, 'sessions');
process.env.PI_SUBAGENT_WORKTREE_DIR = path.join(sandbox, 'worktrees');
const expected = JSON.parse(fs.readFileSync(path.join(repo, 'patches/native-0.8.0-source-hashes.json'), 'utf8'));
assert.equal(JSON.parse(fs.readFileSync(path.join(stock,'package.json'),'utf8')).version, '0.8.0');
for (const [file, hashes] of Object.entries(expected.files)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(stock,file))).digest('hex'), hashes.before, 'Stock file must match exact supported source: '+file);
const copy = path.join(sandbox, 'native');
fs.mkdirSync(path.join(copy, 'src'), { recursive: true });
fs.cpSync(path.join(stock, 'src'), path.join(copy, 'src'), { recursive: true });
const patch = path.join(repo, 'patches/@parke.dev-pi-subagent-v0.8.0-android-proc-safety.patch');
const applied = spawnSync('patch', ['--batch', '-p1', '-i', patch], { cwd: copy, encoding: 'utf8' });
fs.writeFileSync(path.join(out, 'patch.log'), applied.stdout + applied.stderr);
assert.equal(applied.status, 0, 'Exact committed patch must apply to stock copy');
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
assert.equal(sha(patch), expected.patchSha256);
for (const [file, hashes] of Object.entries(expected.files)) assert.equal(sha(path.join(copy,file)), hashes.after, 'Patched copy must match exact expected source: '+file);
const originalRead = fs.readFileSync;
const originalKill = process.kill.bind(process);
let fault = null;
let childPid = null;
let signals = [];
let faultHits = [];
fs.readFileSync = function(file, ...args) {
 const p = String(file);
 if ((fault === 'proc' && p === `/proc/${childPid}/stat`) || (fault === 'boot' && p === '/proc/sys/kernel/random/boot_id')) {
  faultHits.push({fault,path:p});
  const e = new Error('Controlled fixture read denial'); e.code = 'EACCES'; throw e;
 }
 return originalRead.call(fs, file, ...args);
};
process.kill = function(pid, signal = 'SIGTERM') {
 if (signal !== 0) {
  signals.push({ pid, signal });
  assert.ok(pid === childPid || pid === -childPid, 'Refuse every non-owned signal target');
  const e = new Error('Fixture denies actual signal delivery');e.code = 'EPERM';throw e;
 }
 if (fault === 'eperm' && pid === childPid) { faultHits.push({fault,pid}); const e = new Error('Controlled kill(0) denial');e.code = 'EPERM';throw e; }
 return originalKill(pid, signal);
};
syncBuiltinESMExports();
const { createJiti } = require(path.join(sdk, 'node_modules/jiti/lib/jiti.cjs'));
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, interopDefault: true });
const native = await jiti.import(path.join(copy, 'src/process-lock.ts'), { default: false });
const child = spawn(process.execPath, ['-e', 'process.stdout.write("OWNED_READY\\n");setTimeout(()=>process.exit(0),30000);setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: sandbox, ...(process.env.LD_PRELOAD ? {LD_PRELOAD:process.env.LD_PRELOAD}: {}) } });
childPid = child.pid;
await new Promise((resolve, reject) => { child.stdout.once('data', resolve);child.once('error', reject); });
const self = native.currentProcessIdentity();
const identity = { pid: childPid, pgid: childPid, hostname: os.hostname(), startTime: native.processStartTime(childPid), bootId: self.bootId };
assert.equal(process.platform, 'android', 'This probe is real Android, not platform spoofing');
assert.ok(identity.startTime > 0 && identity.bootId, 'Positive real proc/boot capture required');
const rows = [];
let sequence = 0;
const managers = [];
function manager() { const m = new native.ProcessLockManager({ rootDir: path.join(sandbox, 'case-' + (++sequence)), leaseMs: 1 });managers.push(m);return m; }
async function check(name, fn) {
 signals = []; fault = null; faultHits = [];
 try { const details = await fn(); rows.push({case:name,passed:true,faultHits:[...faultHits],...(details || {})}); }
 catch (e) { rows.push({case:name,passed:false,error:String(e),signals:[...signals],faultHits:[...faultHits]}); }
 finally { fault = null; }
}
function record(m, id, processIdentity) { m.writeRunRecord({runId:id,parentSessionKey:'fixture-parent',childSessionId:'fixture-child',worktreeCwd:path.join(sandbox,'preserve-me'),process:processIdentity,startedAt:1,updatedAt:1,state:'running'}); }
try {
 await check('real_android_positive_capture', () => { assert.equal(native.isProcessAlive(identity), true);return {platform:process.platform,startTimePositive:true,bootCaptured:true}; });
 await check('legacy_zero_unknown_preserved', async () => { const m=manager();record(m,'legacy',{...identity,startTime:0,bootId:undefined});const report=await m.reconcileOrphans({killGraceMs:1});assert.ok(report.unknown.includes('legacy'));assert.equal(m.readRunRecord('legacy').state,'running');assert.equal(signals.length,0); });
 await check('legacy_expired_resume_lock_not_taken', () => { const m=manager();const lockPath=path.join(m.rootDir,'sessions/old-session.lock');fs.writeFileSync(lockPath,JSON.stringify({ownerId:'prior-owner',runId:'prior-run',parentSessionKey:'prior-parent',process:{...identity,startTime:0,bootId:undefined},acquiredAt:1,leaseExpiresAt:2,childSessionId:'old-session'}));const result=m.acquireSessionLock('old-session',{ownerId:'new-owner',runId:'new-run',parentSessionKey:'new-parent'});assert.equal(result.ok,false,'unknown live identity must not be reclaimed because two leases expired'); });
 await check('unreadable_proc_unknown_no_signal', async () => { const m=manager();record(m,'unreadable',identity);fault='proc';const report=await m.reconcileOrphans({killGraceMs:1});assert.ok(report.unknown.includes('unreadable'));assert.equal(m.readRunRecord('unreadable').state,'running');assert.equal(signals.length,0); });
 await check('unreadable_boot_unknown_no_signal', async () => { const m=manager();record(m,'boot-unreadable',identity);fault='boot';const report=await m.reconcileOrphans({killGraceMs:1});assert.ok(report.unknown.includes('boot-unreadable'));assert.equal(m.readRunRecord('boot-unreadable').state,'running');assert.equal(signals.length,0); });
 await check('mismatched_birth_never_signals_current_process', async () => { const m=manager();record(m,'reused',{...identity,startTime:identity.startTime+1});const report=await m.reconcileOrphans({killGraceMs:1});assert.ok(report.alreadyDead.includes('reused'));assert.equal(signals.length,0); });
 await check('mismatched_boot_never_signals_current_process', async () => { const m=manager();record(m,'other-boot',{...identity,bootId:crypto.randomUUID()});const report=await m.reconcileOrphans({killGraceMs:1});assert.ok(report.alreadyDead.includes('other-boot'));assert.equal(signals.length,0); });
 await check('failed_signal_does_not_terminalize_live_worker', async () => { const m=manager();record(m,'signal-refused',identity);const report=await m.reconcileOrphans({killGraceMs:1});assert.ok(report.stillAlive.includes('signal-refused'));assert.equal(m.readRunRecord('signal-refused').state,'running','failed signals must not drop busy/live-worktree state'); });
 await check('eperm_identity_does_not_signal_or_terminalize', async () => { const m=manager();record(m,'permission-denied',identity);fault='eperm';const report=await m.reconcileOrphans({killGraceMs:1});assert.ok(report.unknown.includes('permission-denied'));assert.equal(m.readRunRecord('permission-denied').state,'running');assert.equal(signals.length,0); });
 await check('malformed_record_preserved_not_crashed', async () => { const m=manager();record(m,'missing-process',undefined);const report=await m.reconcileOrphans({killGraceMs:1});assert.ok(report.unknown.includes('missing-process'));assert.equal(m.readRunRecord('missing-process').state,'running');assert.equal(signals.length,0); });
} finally {
 for (const m of managers) m.dispose();
 fault = null;fs.readFileSync = originalRead;process.kill = originalKill;syncBuiltinESMExports();
 // Only our held synthetic child is signaled, with actual birth/boot rechecked.
 const live = originalRead(`/proc/${childPid}/stat`, 'utf8').slice().split(')').at(-1).trim().split(/\s+/)[19];
 const currentBoot = originalRead('/proc/sys/kernel/random/boot_id','utf8').trim();
 assert.equal(Number(live),identity.startTime);assert.equal(currentBoot,identity.bootId);
 originalKill(-childPid,'SIGKILL');await new Promise(resolve=>child.once('exit',resolve));
}
const result={base_head:'0ec077e8d31f804dcfad6fd50716901d2858611e',repo,cases:rows,passed:rows.every(r=>r.passed),scope:'Actual native ProcessLockManager over exact copied/patched source, owned synthetic PID and controlled fault injection; NOT full SDK maintenance/GC proof',stock_native_sha256:sha(path.join(stock,'src/process-lock.ts')),patched_copy_sha256:sha(path.join(copy,'src/process-lock.ts')),patch_sha256:sha(patch),live_extension_present:fs.existsSync(path.join(realHome,'.pi/agent/extensions/durable-subagent-recovery.ts'))};
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2),{mode:0o600});
console.log(JSON.stringify(result,null,2));console.log('EVIDENCE',out);
assert.equal(result.passed,true,JSON.stringify(rows,null,2));
return result;

}
