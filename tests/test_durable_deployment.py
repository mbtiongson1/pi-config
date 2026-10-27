#!/usr/bin/env python3
"""Parent-owned, isolated negative installer/rollback matrix. No SDK imports."""
import atexit,hashlib,json,os,shutil,signal,sqlite3,stat,subprocess,tempfile,time,unittest
from pathlib import Path
from datetime import datetime,timezone
REPO=Path(__file__).resolve().parents[1]
OUT=Path(tempfile.mkdtemp(prefix='durable-deployment-tests-'))
atexit.register(shutil.rmtree,OUT,ignore_errors=True)
BASE={k:os.environ[k] for k in ['PATH','PREFIX','TMPDIR','LD_PRELOAD','LD_LIBRARY_PATH','ANDROID_ROOT','ANDROID_DATA'] if k in os.environ}
RESULTS=[]
def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest() if Path(p).is_file() else None
def boot(): return Path('/proc/sys/kernel/random/boot_id').read_text().strip()
def ticks(pid): return Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19]
def create(name):
 root=OUT/name;root.mkdir(mode=0o700)
 env={**BASE,'HOME':str(root/'home'),'PI_CODING_AGENT_DIR':str(root/'agent'),'PI_DURABLE_DIR':str(root/'durable')}
 Path(env['HOME']).mkdir(mode=0o700)
 agent=Path(env['PI_CODING_AGENT_DIR']);(agent/'extensions').mkdir(parents=True,mode=0o700)
 for name in ['auth.json','settings.json','models.json']:(agent/name).write_text(json.dumps({'synthetic_preservation_sentinel':name}))
 return root,env,agent/'extensions/durable-subagent-recovery.ts',Path(env['PI_DURABLE_DIR'])/'deployment-manifest.json'
def run(root,env,mode='install'):
 script=REPO/'bin'/('ensure-durable-recovery.sh' if mode=='install' else 'durable-subagent-doctor.sh')
 cmd=['bash',str(script)]+([] if mode=='install' else ['--rollback'])
 r=subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=30)
 with (root/'commands.log').open('a') as log:log.write(json.dumps({'mode':mode,'exit':r.returncode})+'\n'+r.stdout+r.stderr+'\n')
 return r

def basic_fresh():
 root,env,dest,m=create('fresh');assert run(root,env).returncode==0
 assert run(root,env).returncode==0
 assert run(root,env,'rollback').returncode==0
 assert not dest.exists()
def custom_preimage():
 root,env,dest,m=create('custom');data=b'// synthetic original extension\n';dest.write_bytes(data);dest.chmod(0o640)
 sentinels={p.name:sha(p) for p in dest.parent.parent.glob('*.json')}
 assert run(root,env).returncode==0;first=json.loads(m.read_text())
 assert run(root,env).returncode==0;second=json.loads(m.read_text())
 assert [first[k] for k in ('backupPath','backupSha256','backupMode')]==[second[k] for k in ('backupPath','backupSha256','backupMode')]
 assert run(root,env,'rollback').returncode==0
 assert dest.read_bytes()==data and stat.S_IMODE(dest.stat().st_mode)==0o640
 assert sentinels=={p.name:sha(p) for p in dest.parent.parent.glob('*.json')}
def identical_preimage():
 root,env,dest,m=create('identical');data=(REPO/'extensions/durable-subagent-recovery.ts').read_bytes();dest.write_bytes(data);dest.chmod(0o640)
 assert run(root,env).returncode==0 and run(root,env).returncode==0
 assert run(root,env,'rollback').returncode==0
 assert dest.read_bytes()==data and stat.S_IMODE(dest.stat().st_mode)==0o640

def backup_tamper():
 root,env,dest,m=create('backup-tamper');dest.write_text('// original\n');dest.chmod(0o640)
 assert run(root,env).returncode==0
 backup=Path(json.loads(m.read_text())['backupPath']);backup.write_text('// corrupted backup\n');before=sha(dest)
 assert run(root,env).returncode!=0 and sha(dest)==before
 assert run(root,env,'rollback').returncode!=0 and sha(dest)==before

def no_manifest_eval():
 root,env,dest,m=create('manifest-code');assert run(root,env).returncode==0
 obj=json.loads(m.read_text());marker=root/'benign-eval-marker';obj['backupPath']='$(printf unsafe > '+str(marker)+')';m.write_text(json.dumps(obj));m.chmod(0o600)
 before=sha(dest)
 assert run(root,env).returncode!=0 and not marker.exists() and sha(dest)==before
 assert run(root,env,'rollback').returncode!=0 and not marker.exists() and sha(dest)==before

def target_edit_reinstall():
 root,env,dest,m=create('target-edit');assert run(root,env).returncode==0
 dest.write_text(dest.read_text()+'\n// synthetic user edit must survive\n');before=sha(dest);manifest_before=sha(m)
 r=run(root,env)
 assert r.returncode!=0 and sha(dest)==before and sha(m)==manifest_before,'installer overwrote a user-edited installed extension'

def empty_manifest_rollback():
 root,env,dest,m=create('empty-manifest');assert run(root,env).returncode==0
 m.write_text('{}');m.chmod(0o600);before=sha(dest)
 r=run(root,env,'rollback')
 assert r.returncode!=0 and sha(dest)==before,'empty manifest bypassed hash verification and removed extension'

def db_symlink():
 root,env,dest,m=create('db-symlink');durable=Path(env['PI_DURABLE_DIR']);durable.mkdir(mode=0o700)
 external=root/'outside-managed-sentinel.sqlite'
 c=sqlite3.connect(external);c.execute('CREATE TABLE sentinel(value)');c.execute('INSERT INTO sentinel VALUES(42)');c.commit();c.close();external.chmod(0o640)
 before=sha(external);(durable/'subagents.sqlite').symlink_to(external)
 r=run(root,env)
 assert r.returncode!=0 and sha(external)==before and stat.S_IMODE(external.stat().st_mode)==0o640,'installer followed database symlink and mutated outside-managed SQLite file'

def crash_after_extension_swap():
 root,env,dest,m=create('swap-crash');shim=root/'shim';shim.mkdir(mode=0o700)
 real_mv=shutil.which('mv');marker=root/'extension-swapped'
 mv=shim/'mv';mv.write_text('''#!/usr/bin/env python3
import os,subprocess,sys,time
from pathlib import Path
subprocess.run([os.environ['PROBE_REAL_MV'],*sys.argv[1:]],check=True)
if sys.argv[-1]==os.environ['PROBE_MOVE_TARGET']:
 Path(os.environ['PROBE_MOVE_MARKER']).write_text(str(os.getpid()))
 time.sleep(30)
''');mv.chmod(0o700)
 # Instrument either shell mv or Python os.replace; identical observable swap boundary.
 (shim/'sitecustomize.py').write_text('''import os,time
from pathlib import Path
_original_replace=os.replace
def _replace(src,dst,*args,**kwargs):
 result=_original_replace(src,dst,*args,**kwargs)
 if str(dst)==os.environ.get('PROBE_MOVE_TARGET'):
  Path(os.environ['PROBE_MOVE_MARKER']).write_text(str(os.getpid()))
  time.sleep(30)
 return result
os.replace=_replace
''')
 crash_env={**env,'PATH':str(shim)+os.pathsep+env['PATH'],'PYTHONPATH':str(shim),'PROBE_REAL_MV':real_mv,'PROBE_MOVE_TARGET':str(dest),'PROBE_MOVE_MARKER':str(marker)}
 with (root/'crash.log').open('w') as log:
  proc=subprocess.Popen(['bash',str(REPO/'bin/ensure-durable-recovery.sh')],env=crash_env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  born=ticks(proc.pid);boot_id=boot()
  try:
   deadline=time.monotonic()+10
   while not marker.exists() and time.monotonic()<deadline:
    if proc.poll() is not None:break
    time.sleep(.02)
   assert marker.exists(),'swap fault injection did not reach target'
   assert ticks(proc.pid)==born and boot()==boot_id and os.getpgid(proc.pid)==proc.pid
   os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
  finally:
   if proc.poll() is None:
    assert ticks(proc.pid)==born and boot()==boot_id
    os.killpg(proc.pid,signal.SIGKILL);proc.wait(timeout=5)
 assert dest.exists() and not m.exists(),'unexpected fault-injection ordering'
 assert run(root,env).returncode==0
 assert run(root,env,'rollback').returncode==0
 assert not dest.exists(),'process crash lost original ABSENCE; reinstall+rollback retained new extension as fake preimage'



def replacement_versions():
 for exists in (False,True):
  root,env,dest,m=create("replacement-"+str(exists))
  original=b"// first preimage\n"
  if exists:dest.write_bytes(original);dest.chmod(0o640)
  assert run(root,env).returncode==0
  first=json.loads(m.read_text())
  candidate=root/"candidate-next.ts";candidate.write_bytes((REPO/"extensions/durable-subagent-recovery.ts").read_bytes()+b"\n// next managed release\n")
  r=subprocess.run(["python3",str(REPO/"bin/durable-recovery-deploy.py"),"install","--agent-dir",env["PI_CODING_AGENT_DIR"],"--durable-dir",env["PI_DURABLE_DIR"],"--source",str(candidate)],env=env,capture_output=True,text=True,timeout=30)
  assert r.returncode==0,r.stderr
  updated=json.loads(m.read_text())
  assert [first[k] for k in ("backupPath","backupSha256","backupMode")]==[updated[k] for k in ("backupPath","backupSha256","backupMode")]
  assert run(root,env,"rollback").returncode==0
  if exists:assert dest.read_bytes()==original and stat.S_IMODE(dest.stat().st_mode)==0o640
  else:assert not dest.exists()


class TestDurableDeployment(unittest.TestCase):
    """Real script invocations, never an installer against the actual HOME."""
    def test_replacement_versions_preserve_first_preimage(self): replacement_versions()
    def test_fresh_reinstall_rollback(self): basic_fresh()
    def test_custom_preimage_mode_and_sentinels(self): custom_preimage()
    def test_identical_preimage(self): identical_preimage()
    def test_backup_tamper_refused(self): backup_tamper()
    def test_manifest_code_not_executed(self): no_manifest_eval()
    def test_edited_target_not_overwritten(self): target_edit_reinstall()
    def test_empty_manifest_not_authoritative(self): empty_manifest_rollback()
    def test_database_symlink_not_followed(self): db_symlink()
    def test_swap_crash_preserves_true_absence(self): crash_after_extension_swap()

if __name__ == '__main__': unittest.main()
