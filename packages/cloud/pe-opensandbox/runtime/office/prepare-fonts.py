"""Extract complete Simplified Chinese faces from Noto TTCs without dropping glyphs."""
import argparse
import hashlib
import json
import struct
from pathlib import Path
from fontTools.ttLib import TTFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=Path('/usr/share/fonts/opentype/noto'))
parser.add_argument('--output', type=Path, default=Path('/opt/dsh/fonts'))
args = parser.parse_args()
(args.output / 'cjk').mkdir(parents=True, exist_ok=True)
records = []
for family in ['Sans', 'Serif']:
    for weight in ['Regular', 'Bold']:
        source = args.source / f'Noto{family}CJK-{weight}.ttc'
        destination = args.output / 'cjk' / f'Noto{family}CJKsc-{weight}.otf'
        font = TTFont(source, fontNumber=2, recalcTimestamp=False, lazy=True)
        preserved = {tag: hashlib.sha256(font.getTableData(tag)).hexdigest() for tag in ['CFF ', 'cmap', 'maxp']}
        glyphs = struct.unpack_from('>H', font.getTableData('maxp'), 4)[0]
        font.save(destination)
        checked = TTFont(destination, recalcTimestamp=False, lazy=True)
        if any(hashlib.sha256(checked.getTableData(tag)).hexdigest() != digest for tag, digest in preserved.items()):
            raise ValueError('Extracted font changed glyphs or Unicode mappings')
        records.append(dict(source=source.name, sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                            file=destination.name, sha256=hashlib.sha256(destination.read_bytes()).hexdigest(), glyphs=glyphs))
        checked.close(); font.close()
        del checked, font
        print(destination.name, glyphs, flush=True)
(args.output / 'font-manifest.json').write_text(json.dumps(records, indent=2) + '\n')
(args.output / 'fonts.conf').write_text('''<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/opt/dsh/fonts/cjk</dir>
  <dir>/usr/share/fonts/truetype/liberation</dir>
  <dir>/usr/share/texmf/fonts/opentype</dir>
  <dir>/usr/share/texlive/texmf-dist/fonts/opentype/public/fandol</dir>
  <cachedir prefix="xdg">fontconfig</cachedir>
  <alias><family>宋体</family><prefer><family>Noto Serif CJK SC</family></prefer></alias>
  <alias><family>黑体</family><prefer><family>Noto Sans CJK SC</family></prefer></alias>
  <alias><family>Times New Roman</family><prefer><family>Liberation Serif</family></prefer></alias>
</fontconfig>
''')
