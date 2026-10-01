#!/usr/bin/env python3
"""Copy-only narrow faults against a committed real projection/test baseline."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / '.pi/upgrade-checks/writer-mutations'
OUT.mkdir(parents=True, exist_ok=True)
HEAD = subprocess.check_output(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], text=True).strip()
TARGET = 'packages/protocol/src/history-projection.ts'
CASE = '''    case "writer":
      // 已通过共用 schema 的登记元数据；写权 epoch 不冒充回合 generation，也不改变任何裁决。
      return { source: "journal", locator, raw, event: { ...evBase(null, null), kind: "unknown-line" } };
'''
ansi = re.compile(r'\x1b\[[0-9;]*m')
with tempfile.TemporaryDirectory(prefix='writer-projection-mutation-') as temp:
    base = Path(temp) / 'copy'
    base.mkdir()
    archive = subprocess.check_output(['git', '-C', str(REPO), 'archive', HEAD])
    with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
        tree.extractall(base, filter='data')
    (base / 'node_modules').symlink_to(REPO / 'node_modules', target_is_directory=True)
    config = base / 'writer-only.config.mjs'
    # The workspace symlink otherwise resolves to the original protocol package.
    # Explicit alias binds all public protocol imports to this disposable copy.
    config.write_text('import { defineConfig } from "vitest/config";\nexport default defineConfig(' + json.dumps({
        'resolve': {'alias': {'@pi-agent-ui/protocol': str(base / 'packages/protocol/src/index.ts')}},
        'test': {'environment': 'node', 'include': ['tests/unit/history-projection.test.ts']},
    }) + ');\n')
    path = base / TARGET
    original = path.read_text()
    assert original.count(CASE) == 1, 'Expected committed narrow writer branch missing'
    faults = [
        ('remove-writer-recognition', original.replace(CASE, '', 1)),
        ('bypass-shared-schema', original.replace('if (journalLineSchemaError(parsed as UnknownRecord) !== null)', 'if (false)', 1)),
        ('epoch-masquerades-as-generation', original.replace(CASE, CASE.replace('evBase(null, null)', 'evBase(j.epoch, null)'), 1)),
        ('unknown-verdict-becomes-settled', original.replace('kind: "verdict-unknown"', 'kind: "verdict-settled"', 1)),
    ]
    evidence = []
    for key, source in [('baseline', original), *faults]:
        path.write_text(source)
        run = subprocess.run([str(REPO / 'node_modules/.bin/vitest'), 'run', '--config', str(config)],
                             cwd=base, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=35)
        raw = run.stdout
        (OUT / f'{key}.log.gz').write_bytes(gzip.compress(raw, mtime=0))
        text = ansi.sub('', raw.decode('utf-8', errors='replace'))
        (OUT / f'{key}.log').write_text(text.rstrip('\r\n') + '\n')
        failed = re.search(r'Tests\s+(\d+) failed', text)
        if key == 'baseline':
            valid = run.returncode == 0 and re.search(r'Tests\s+36 passed', text) is not None
        else:
            valid = run.returncode == 1 and failed is not None and int(failed[1]) > 0
        evidence.append({'fault': key, 'exitCode': run.returncode, 'failedAssertions': int(failed[1]) if failed else 0,
                         'validEvidence': valid, 'copySourceSha256': hashlib.sha256(source.encode()).hexdigest()})
        assert valid, f'Not valid mutation evidence: {key}; see {OUT / (key + ".log")}'
    # A removed copied branch must truly fail, proving the alias is not original-source green.
    report = {'baselineCommit': HEAD, 'source': TARGET, 'copiedPublicImportAlias': True,
              'repositorySourceTouched': False, 'results': evidence,
              'limitation': 'narrow pure projection faults, not recovery/writer/whole UI mutation acceptance'}
    (OUT / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    assert (REPO / TARGET).read_text() == original, 'Original source changed while running copy-only faults'
print(json.dumps(report, ensure_ascii=False))
