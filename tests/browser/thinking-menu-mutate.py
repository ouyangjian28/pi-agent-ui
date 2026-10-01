#!/usr/bin/env python3
"""Committed, disposable consumer copies. Assertion-red only, never live mutations."""
import gzip, hashlib, io, json, re, subprocess, tarfile, tempfile
from pathlib import Path
REPO=Path(__file__).resolve().parents[2]
OUT=REPO/'.pi/composer-checks/thinking-menu/mutations'; OUT.mkdir(parents=True,exist_ok=True)
HEAD=subprocess.check_output(['git','-C',str(REPO),'rev-parse','HEAD'],text=True).strip()
PICKER='apps/web/src/components/thinking-picker.tsx'; CLIENT='apps/web/src/ws/ws-client.ts'; CATALOG='apps/server/src/ws/models-thinking.ts'
FAULTS=[
 ('unknown-capabilities-guessed', PICKER, 'const levels = candidates.length === 1 ? candidates[0]?.thinkingLevels : undefined;', 'const levels = candidates.length === 1 ? candidates[0]?.thinkingLevels : ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;'),
 ('silent-clamp-existing-choice', PICKER, 'value={level ?? ""}', 'value={selectedUnsupported ? "" : level ?? ""}'),
 ('ambiguous-alias-first-match', PICKER, 'candidates.length === 1 ? candidates[0]?.thinkingLevels', 'candidates.length > 0 ? candidates[0]?.thinkingLevels'),
 ('duplicate-levels-accepted', CLIENT, 'new Set(v.thinkingLevels).size !== v.thinkingLevels.length', 'false'),
 ('wrong-sdk-version-enriched', CATALOG, 'if (!(await matchesSdkVersion(piBin))) return entries;', 'if (false) return entries;'),
]
ansi=re.compile(r'\x1b\[[0-9;]*m'); results=[]
with tempfile.TemporaryDirectory(prefix='thinking-menu-mutation-') as temp:
 base=Path(temp)/'copy'; base.mkdir()
 with tarfile.open(fileobj=io.BytesIO(subprocess.check_output(['git','-C',str(REPO),'archive',HEAD]))) as archive: archive.extractall(base,filter='data')
 (base/'node_modules').symlink_to(REPO/'node_modules',target_is_directory=True)
 config=base/'thinking-faults.config.mjs'
 config.write_text('import { defineConfig } from "vitest/config";\nexport default defineConfig('+json.dumps({'resolve':{'alias':{'@pi-agent-ui/protocol/src':str(base/'packages/protocol/src'),'@pi-agent-ui/protocol':str(base/'packages/protocol/src/index.ts')}},'test':{'projects':[
 {'extends':True,'test':{'name':'server-catalog','environment':'node','include':['tests/unit/server/models-thinking.test.ts','tests/unit/server/model-listing.test.ts']}},
 {'extends':True,'test':{'name':'real-menu-consumer','environment':'jsdom','include':['tests/unit/web/thinking-picker.test.ts','tests/unit/web/ws-client.test.ts']}},
 ]}})+');\n')
 originals={p:(base/p).read_text() for p in {PICKER,CLIENT,CATALOG}}
 for name,target,old,new in [('baseline',PICKER,'',''),*FAULTS]:
  for path,text in originals.items(): (base/path).write_text(text)
  if name!='baseline':
   assert originals[target].count(old)==1, name
   (base/target).write_text(originals[target].replace(old,new,1))
  proc=subprocess.run([str(REPO/'node_modules/.bin/vitest'),'run','--config',str(config)],cwd=base,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=40)
  raw=proc.stdout; (OUT/(name+'.log.gz')).write_bytes(gzip.compress(raw,mtime=0)); text=ansi.sub('',raw.decode(errors='replace')); (OUT/(name+'.log')).write_text(text)
  failed=re.search(r'Tests\s+(\d+) failed',text); passed=re.search(r'(\d+) passed',text.split('Tests')[-1]); valid=(proc.returncode==0 and passed is not None) if name=='baseline' else (proc.returncode==1 and failed is not None and int(failed[1])>0 and passed is not None)
  results.append({'fault':name,'source':target,'exitCode':proc.returncode,'failedAssertions':int(failed[1]) if failed else 0,'validEvidence':valid,'copySourceSha256':hashlib.sha256((base/target).read_bytes()).hexdigest(),'rawLogSha256':hashlib.sha256(raw).hexdigest()})
  (OUT/'result.json').write_text(json.dumps({'baselineCommit':HEAD,'consumerCopyPublicProtocolAlias':True,'repositorySourceTouched':False,'results':results,'limitation':'Five narrow menu/consumer/version faults only; not authentication/provider/transport/full unknown-intent restart acceptance'},ensure_ascii=False,indent=2)+'\n')
  assert valid, f'Invalid evidence {name}: {OUT/(name+".log")}'
  print(name,proc.returncode,flush=True)
 for path,text in originals.items(): assert (REPO/path).read_text()==text,path
print('5 copy-only thinking menu faults killed; baseline '+HEAD,flush=True)
