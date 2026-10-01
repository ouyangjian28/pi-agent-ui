#!/usr/bin/env python3
"""Consumer-only copy faults, from a committed baseline; no live source mutation."""
import gzip, hashlib, io, json, re, subprocess, tarfile, tempfile
from pathlib import Path
REPO = Path(__file__).resolve().parents[2]
OUT = REPO / '.pi/composer-checks/mutations'
OUT.mkdir(parents=True, exist_ok=True)
HEAD = subprocess.check_output(['git','-C',str(REPO),'rev-parse','HEAD'], text=True).strip()
PROMPT = 'apps/server/src/runtime/prompt-attachments.ts'
STORE = 'apps/server/src/http/attachment-store.ts'
OWNER = 'apps/web/src/ws/conversation-state.ts'
FAULTS = [
 ('image-bytes-change', PROMPT, 'Buffer.from(item.bytes).toString("base64")', 'Buffer.from("changed-image").toString("base64")'),
 ('restore-other-owner', PROMPT, ' || snapshot.owner !== owner', ''),
 ('restore-object-drift', PROMPT, 'prepared.snapshot.objects.some((item, i) => !sameObject(item, snapshot.objects[i]!))', 'false'),
 ('restore-image-count-order', PROMPT, 'prepared.hashes.length !== expectedHashes.length || prepared.hashes.some((hash, i) => hash !== expectedHashes[i])', 'false'),
 ('pin-can-be-deleted', STORE, ' || this.mutating.has(id)', ''),
 ('late-ack-clears-new-files', OWNER, ' && current.version === op.version', ''),
 ('send-during-upload', OWNER, 'if (slot.uploading) return Promise.resolve({ status: "local", kind: "in-flight", message: "附件正在上传，未发送。" });', ''),
]
ansi = re.compile(r'\x1b\[[0-9;]*m')
results = []
with tempfile.TemporaryDirectory(prefix='composer-mutation-') as temp:
 base = Path(temp) / 'copy'; base.mkdir()
 with tarfile.open(fileobj=io.BytesIO(subprocess.check_output(['git','-C',str(REPO),'archive',HEAD]))) as tree:
  tree.extractall(base, filter='data')
 (base/'node_modules').symlink_to(REPO/'node_modules', target_is_directory=True)
 config = base/'composer-faults.config.mjs'
 config.write_text('import { defineConfig } from "vitest/config";\nexport default defineConfig('+json.dumps({
  'resolve': {'alias': {'@pi-agent-ui/protocol/src': str(base/'packages/protocol/src'), '@pi-agent-ui/protocol': str(base/'packages/protocol/src/index.ts')}},
  'test': {'projects': [
   {'extends':True,'test':{'name':'server-fault','environment':'node','include':['tests/unit/server/prompt-attachments.test.ts','tests/unit/server/attachment-pin-race.test.ts']}},
   {'extends':True,'test':{'name':'owner-fault','environment':'jsdom','include':['tests/unit/web/composer-attachments-owner.test.ts']}},
  ]}
 })+');\n')
 originals = {key:(base/key).read_text() for key in {PROMPT,STORE,OWNER}}
 for key, target, old, new in [('baseline',PROMPT,'',''), *FAULTS]:
  for file, text in originals.items(): (base/file).write_text(text)
  if key != 'baseline':
   assert originals[target].count(old)==1, f'Fault anchor not unique: {key}'
   (base/target).write_text(originals[target].replace(old,new,1))
  proc = subprocess.run([str(REPO/'node_modules/.bin/vitest'),'run','--config',str(config)],cwd=base,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=35)
  raw=proc.stdout; (OUT/f'{key}.log.gz').write_bytes(gzip.compress(raw,mtime=0))
  text=ansi.sub('',raw.decode(errors='replace')); (OUT/f'{key}.log').write_text(text)
  failed=re.search(r'Tests\s+(\d+) failed',text); passed=re.search(r'(\d+) passed', text.split('Tests')[-1])
  valid=(proc.returncode==0 and passed is not None) if key=='baseline' else (proc.returncode==1 and failed is not None and int(failed[1])>0 and passed is not None)
  results.append({'fault':key,'source':target,'exitCode':proc.returncode,'failedAssertions':int(failed[1]) if failed else 0,'validEvidence':valid,'copySourceSha256':hashlib.sha256((base/target).read_bytes()).hexdigest(),'rawLogSha256':hashlib.sha256(raw).hexdigest()})
  (OUT/'result.json').write_text(json.dumps({'baselineCommit':HEAD,'consumerCopyPublicProtocolAlias':True,'repositorySourceTouched':False,'results':results,'limitation':'7 narrow consumer/byte/owner faults only; not decoder/transport/configuration/whole-app crash recovery mutation acceptance'},ensure_ascii=False,indent=2)+'\n')
  assert valid, f'Invalid evidence {key}; see {OUT/(key+".log")}'
  print(key,proc.returncode,flush=True)
 for file,text in originals.items(): assert (REPO/file).read_text()==text, f'Original changed: {file}'
print('7 copy-only consumer faults killed; baseline '+HEAD,flush=True)
