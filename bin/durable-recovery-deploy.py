#!/usr/bin/env python3
"""Private, compare-safe deployment of the recovery extension (not Pi packages).

Rollback restores the state before the FIRST managed installation, across
idempotent reinstalls and managed version replacements. A fsynced intent permits
logical recovery after process death between extension and manifest replacement.
This is not authorization for replaying agent/API/Git effects.
"""
from __future__ import annotations
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

NAME = 'durable-subagent-recovery.ts'
HEX = re.compile(r'^[0-9a-f]{64}$')
BACKUP = re.compile(r'^durable-subagent-recovery\.ts\.bak\.[0-9a-f-]+$')
STAGE = re.compile(r'^\.durable-subagent-recovery\.stage\.[0-9a-f-]+$')

class UnsafeState(Exception): pass

def digest(data): return hashlib.sha256(data).hexdigest()
def encode(value): return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()
def sync_dir(p):
    fd = os.open(p, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try: os.fsync(fd)
    finally: os.close(fd)

def regular(p, *, private=False):
    st = p.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_nlink != 1:
        raise UnsafeState(f'Not an owned, single-link regular file: {p}')
    mode = stat.S_IMODE(st.st_mode)
    if mode > 0o777 or (private and mode != 0o600):
        raise UnsafeState(f'Unsafe file mode: {p}')
    return mode

def contents(p, *, private=False):
    mode = regular(p, private=private)
    fd = os.open(p, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        st = os.fstat(fd)
        if st.st_ino != p.lstat().st_ino or st.st_uid != os.getuid() or st.st_nlink != 1:
            raise UnsafeState(f'File changed during validation: {p}')
        with os.fdopen(fd, 'rb', closefd=False) as f: data = f.read()
    finally: os.close(fd)
    return data, mode

def fingerprint(p):
    if not os.path.lexists(p): return None
    data, mode = contents(p)
    return {'sha256': digest(data), 'mode': mode}

def owned_dir(p, *, private=False):
    if os.path.lexists(p):
        st = p.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o022:
            raise UnsafeState(f'Unsafe directory namespace: {p}')
        if private and stat.S_IMODE(st.st_mode) != 0o700:
            raise UnsafeState(f'Private directory must have mode0700: {p}')
    else:
        p.mkdir(parents=True, mode=0o700)

def atomic_bytes(p, data, mode=0o600):
    tmp = p.parent / ('.durable-write.' + str(uuid.uuid4()))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as f: f.write(data); f.flush()
        os.fsync(fd)
    finally: os.close(fd)
    os.replace(tmp, p)
    sync_dir(p.parent)

def validate_fp(value):
    if value is None: return
    if not isinstance(value, dict) or set(value) != {'sha256', 'mode'} or not isinstance(value['sha256'], str) or not HEX.fullmatch(value['sha256']) or type(value['mode']) is not int or not 0 <= value['mode'] <= 0o777:
        raise UnsafeState('Malformed file fingerprint')

class Deployment:
    def __init__(self, agent, durable):
        # Leaf namespaces may not be aliases; platform parent aliases are not rewritten.
        self.agent = Path(os.path.abspath(agent)); self.durable = Path(os.path.abspath(durable))
        self.extdir = self.agent / 'extensions'; self.dest = self.extdir / NAME
        self.manifest = self.durable / 'deployment-manifest.json'
        self.intent = self.durable / 'deployment-intent.json'
        owned_dir(self.agent); owned_dir(self.extdir); owned_dir(self.durable, private=True)
        owned_dir(self.durable / 'sessions', private=True)

    def backup_path(self, raw):
        if not isinstance(raw, str): raise UnsafeState('Invalid backup path type')
        p = Path(raw)
        if not p.is_absolute() or p.parent != self.durable or not BACKUP.fullmatch(p.name):
            raise UnsafeState('Backup outside expected private namespace')
        return p

    def validate_manifest(self, value):
        if not isinstance(value, dict) or value.get('schemaVersion') != 2:
            raise UnsafeState('Missing/unsupported deployment manifest schema; do not guess legacy preimages')
        for k in ('sourceSha256', 'installedSha256'):
            if not isinstance(value.get(k), str) or not HEX.fullmatch(value[k]): raise UnsafeState('Missing/invalid installed/source hash')
        if value['sourceSha256'] != value['installedSha256']: raise UnsafeState('Inconsistent installed/source hash')
        if type(value.get('installedMode')) is not int or not 0 <= value['installedMode'] <= 0o777: raise UnsafeState('Missing/invalid installed mode')
        backup, sha, mode = (value.get(k) for k in ('backupPath', 'backupSha256', 'backupMode'))
        if backup is None:
            if sha is not None or mode is not None: raise UnsafeState('Partial absence preimage')
        else:
            p = self.backup_path(backup)
            if not isinstance(sha, str) or not HEX.fullmatch(sha) or type(mode) is not int or not 0 <= mode <= 0o777: raise UnsafeState('Malformed preimage hash/mode')
            if fingerprint(p) != {'sha256': sha, 'mode': mode}: raise UnsafeState('Preimage contents/mode changed')
        return value

    def load_manifest(self):
        if not os.path.lexists(self.manifest): return None
        data, _ = contents(self.manifest, private=True)
        return self.validate_manifest(json.loads(data))

    @staticmethod
    def installed(value): return {'sha256': value['installedSha256'], 'mode': value['installedMode']}
    @staticmethod
    def original(value): return None if value['backupPath'] is None else {'sha256': value['backupSha256'], 'mode': value['backupMode']}

    def check_database_paths(self):
        for suffix in ('', '-wal', '-shm'):
            p = self.durable / ('subagents.sqlite' + suffix)
            if os.path.lexists(p): regular(p, private=True)

    @contextlib.contextmanager
    def locked(self):
        p = self.durable / '.deployment.lock'
        if os.path.lexists(p): regular(p, private=True)
        fd = os.open(p, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            os.fchmod(fd, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.check_database_paths()
            self.recover()
            yield
        finally: os.close(fd)

    def recover(self):
        if not os.path.lexists(self.intent): return
        data, _ = contents(self.intent, private=True); j = json.loads(data)
        if not isinstance(j, dict) or j.get('schemaVersion') != 1 or j.get('operation') not in ('install', 'rollback'): raise UnsafeState('Invalid deployment intent')
        before, after = j.get('before'), j.get('after')
        validate_fp(before); validate_fp(after)
        bm, am = j.get('manifestBefore'), j.get('manifestAfter')
        if bm is not None: self.validate_manifest(bm)
        if am is not None: self.validate_manifest(am)
        mbfp = j.get('manifestBeforeFingerprint'); validate_fp(mbfp)
        if (bm is None) != (mbfp is None): raise UnsafeState('Inconsistent prior manifest')
        if j['operation'] == 'install':
            if am is None or after != self.installed(am): raise UnsafeState('Invalid install intent')
            if bm is None:
                if before != self.original(am): raise UnsafeState('Initial preimage intent mismatch')
            elif before != self.installed(bm) or self.original(am) != self.original(bm) or am['backupPath'] != bm['backupPath']:
                raise UnsafeState('Replacement intent loses original preimage')
        elif bm is None or am is not None or before != self.installed(bm) or after != self.original(bm): raise UnsafeState('Invalid rollback intent')
        current_manifest = fingerprint(self.manifest)
        after_manifest_fp = None if am is None else {'sha256': digest(encode(am)), 'mode': 0o600}
        if current_manifest not in (mbfp, after_manifest_fp): raise UnsafeState('Manifest changed during pending deployment')
        current = fingerprint(self.dest)
        if current not in (before, after): raise UnsafeState('Extension changed during pending deployment; preserving all state')
        stage = j.get('stagePath')
        if stage is not None:
            stage = Path(stage)
            if stage.parent != self.extdir or not STAGE.fullmatch(stage.name): raise UnsafeState('Stage path outside extension namespace')
        if current != after:
            if after is None:
                self.dest.unlink(); sync_dir(self.extdir)
            else:
                if stage is None or fingerprint(stage) != after: raise UnsafeState('Missing or edited prepared stage; preserve pending intent')
                os.replace(stage, self.dest); sync_dir(self.extdir)
        if am is None:
            if os.path.lexists(self.manifest): self.manifest.unlink(); sync_dir(self.durable)
        else: atomic_bytes(self.manifest, encode(am))
        self.intent.unlink(); sync_dir(self.durable)
        if stage is not None and os.path.lexists(stage):
            if fingerprint(stage) != after: raise UnsafeState('Unexpected stage retained for diagnosis')
            stage.unlink(); sync_dir(self.extdir)
        print('Recovered/committed compare-safe deployment intent.')

    def transact(self, operation, before, after, bm, am, payload=None):
        stage = None
        if after is not None:
            stage = self.extdir / ('.durable-subagent-recovery.stage.' + str(uuid.uuid4()))
            atomic_bytes(stage, payload, after['mode'])
            if fingerprint(stage) != after: raise UnsafeState('Prepared stage fingerprint mismatch')
        j = {'schemaVersion':1,'operation':operation,'before':before,'after':after,'manifestBefore':bm,'manifestAfter':am,'manifestBeforeFingerprint':fingerprint(self.manifest),'stagePath':None if stage is None else str(stage)}
        atomic_bytes(self.intent, encode(j))
        self.recover()

    def preflight(self):
        with self.locked():
            m = self.load_manifest()
            if m is not None and fingerprint(self.dest) != self.installed(m): raise UnsafeState('Installed extension was edited or removed; refusing overwrite')
            if m is None: fingerprint(self.dest)
        print('Deployment namespace/preimage preflight passed.')

    def install(self, source):
        with self.locked():
            data, _ = contents(Path(source)); before = fingerprint(self.dest); m = self.load_manifest()
            after = {'sha256':digest(data),'mode':0o600}
            if m is not None:
                if before != self.installed(m): raise UnsafeState('Installed extension was edited or removed; refusing overwrite')
                if before == after: print('Identical deployment; original preimage unchanged.'); return
                backup, backup_sha, backup_mode = (m[k] for k in ('backupPath','backupSha256','backupMode'))
            elif before is not None:
                original, original_mode = contents(self.dest)
                p = self.durable / (NAME + '.bak.' + str(uuid.uuid4()))
                atomic_bytes(p, original, original_mode)
                backup, backup_sha, backup_mode = str(p), digest(original), original_mode
            else: backup = backup_sha = backup_mode = None
            am = {'schemaVersion':2,'sourceSha256':after['sha256'],'installedSha256':after['sha256'],'installedMode':after['mode'],'backupPath':backup,'backupSha256':backup_sha,'backupMode':backup_mode}
            self.transact('install', before, after, m, am, data)
        print('Extension deployed; original first-install preimage retained.')

    def rollback(self):
        with self.locked():
            m = self.load_manifest(); before = fingerprint(self.dest)
            if m is None:
                if before is not None: raise UnsafeState('Deployment manifest missing; refusing to remove an untracked extension')
                print('No managed extension deployed.'); return
            if before != self.installed(m): raise UnsafeState('Installed extension was edited or removed; refusing rollback')
            after = self.original(m)
            payload = None if after is None else contents(self.backup_path(m['backupPath']))[0]
            self.transact('rollback', before, after, m, None, payload)
        print('Original extension state restored; jobs/database/settings/auth/models untouched.')

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('operation', choices=['preflight','install','rollback'])
    p.add_argument('--agent-dir', required=True); p.add_argument('--durable-dir', required=True); p.add_argument('--source')
    a = p.parse_args()
    try:
        d = Deployment(a.agent_dir, a.durable_dir)
        if a.operation == 'install':
            if not a.source: p.error('--source required for install')
            d.install(a.source)
        elif a.operation == 'rollback': d.rollback()
        else: d.preflight()
        return 0
    except (UnsafeState, OSError, ValueError, KeyError, TypeError) as e:
        print('Refusing unsafe deployment: ' + str(e), file=sys.stderr); return 1

if __name__ == '__main__': raise SystemExit(main())
