"""Current Native-change categories and centralized internal-read locations."""
import csv
import io
import re

OWN = re.compile(r'^(?:packages/(?:cloud|community)/|integrations/epri-research/|deploy/)')
TEST = re.compile(r'(?:\.(?:spec|test)\.[tj]sx?$|/tests?/|__snapshots__|\.snap$|^snapshots/)')
DOC = re.compile(r'(?:\.(?:md|mdx)$|^docs/|i18n\.ya?ml$)')
CONFIG = re.compile(r'(?:package\.json$|pnpm-lock|pnpm-workspace|tsconfig|\.ya?ml$|\.json$|Makefile|\.toml$)')
SOURCE = re.compile(r'\.(?:ts|tsx|js|mjs|cjs|py|c|h|css|scss|sh)$')
HEADER = ['路径', '类别', '原因', '撤销条件', '处置', '这一程的状态']
CENTRAL = {
    'pe-cloud-runtime': 'packages/cloud/pe-cloud-runtime/src/native-state.ts',
    'pe-cloud-api': 'packages/cloud/pe-cloud-api/src/native-inventory.ts',
    'pe-cloud-access': 'packages/cloud/pe-cloud-access/src/native-internals.ts',
    'pe-cloud-files': 'packages/cloud/pe-cloud-files/src/native-internals.ts',
    'pe-cloud-client': 'packages/cloud/pe-cloud-client/src/native-internals.ts',
    'pe-opensandbox': 'packages/cloud/pe-opensandbox/src/native-internals.ts',
    'pe-account-instructions': 'packages/cloud/pe-account-instructions/src/native-internals.ts',
    'remote-server': 'packages/community/remote-server/src/native-internals.ts',
}
# The original inventory's structural checks, extended for current Cordis records.
# Public Fiber.state checks do not inspect a private service record.
PATTERNS = {
    'proxy-original': r'symbols\.original',
    'isolate-reflect-store': r'symbols\.isolate|\.reflect\.store',
    'fiber-store': r'\b(?:fiber|runtime|scope)\.store\b',
    'fiber-records': r'\.(?:provisions|committed)\b',
    'fiber-runtime': r'\.runtime[?!]?\.(?:callback|Config)',
    'registry-fibers': r'\.registry\.(?:get|values|keys|entries)|\.fibers\b',
    'loader-entry': r'\.moduleNamespace\b|\bentry\.(?:options|disabled|subtree|parent|fiber|config)\b|\.parent\.tree\.(?:import|ctx)\b',
    'loader-builtins': r'\.builtins\b|\bbuiltins\[|Object\.assign\(builtins',
    'internal-events': r'[\'\"](?:internal/(?:plugin|service|status|update|config)|loader/(?:entry-init|partial-dispose|volatile-update|patch-context))[\'\"]',
    'fiber-config': r'\bfiber\??\.(?:_config|config|rawConfig|effectiveConfig)|\.fiber\??\.config|resolveConfig\(',
    'fiber-deref': r'\.fiber\??\.deref\(',
    'reflect-record': r'Reflect\.get\([^,\n]+,\s*[\'\"](?:_store|rawConfig|effectiveConfig|moduleNamespace|provisions|committed)[\'\"]',
}


def native_source(path):
    """Use the existing upstream check's source-file exclusions."""
    return not any(pattern.search(path) for pattern in (OWN, TEST, DOC, CONFIG)) and bool(SOURCE.search(path))


def ledger(text):
    """Read both the original ledger and its six-column successor."""
    rows = list(csv.reader(io.StringIO(text), delimiter='\t'))
    if not rows or rows[0] not in (HEADER, HEADER[:4]):
        raise ValueError('ledger.tsv must have the four original columns and optional disposition/status columns')
    header = rows.pop(0)
    result = []
    seen = set()
    for number, values in enumerate(rows, 2):
        if len(values) != len(header) or not all(values):
            raise ValueError(f'ledger.tsv line {number} has empty or missing columns')
        if values[0] in seen:
            raise ValueError(f'Duplicate ledger path: {values[0]}')
        seen.add(values[0])
        result.append(dict(zip(header, values)))
    return result


def internals(sources):
    """Count matched source lines once, preserving every matched structural category."""
    result = []
    compiled = {name: re.compile(pattern) for name, pattern in PATTERNS.items()}
    for path, text in sorted(sources.items()):
        parts = path.split('/')
        plugin = parts[2] if path.startswith(('packages/cloud/', 'packages/community/')) else 'epri-research'
        for number, line in enumerate(text.splitlines(), 1):
            if line.lstrip().startswith(('//', '*', '/*')):
                continue
            categories = [name for name, pattern in compiled.items() if pattern.search(line)]
            if categories:
                result.append(dict(path=path, line=number, plugin=plugin, categories=categories,
                                   code=line.strip(), centralized=path == CENTRAL.get(plugin)))
    return result
