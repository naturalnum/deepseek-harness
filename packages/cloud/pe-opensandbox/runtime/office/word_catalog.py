"""Preserve technical-report Word fields while replacing their cached page references."""
from copy import deepcopy
import json
from pathlib import Path
import re
import shutil
from zipfile import ZipFile
from lxml import etree as E

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}

def parse_xml(value):
    if b'<!DOCTYPE' in value:
        raise ValueError('Document type declarations are unsupported')
    return E.fromstring(value, E.XMLParser(resolve_entities=False, no_network=True))
def tag(name): return '{' + W + '}' + name
def xml(node): return E.tostring(node, encoding='UTF-8', xml_declaration=True, standalone=True)
def normalized(value): return re.sub(r'\s+', '', value)

def fields(root):
    stack, found = [], []
    for node in root.iter():
        if node.tag == tag('fldChar'):
            kind = node.get(tag('fldCharType'))
            if kind == 'begin': stack.append({'begin': node, 'instruction': [], 'separator': None})
            elif kind == 'separate' and stack: stack[-1]['separator'] = node
            elif kind == 'end' and stack:
                value = stack.pop(); value['end'] = node
                value['code'] = ''.join(n.text or '' for n in value['instruction'])
                found.append(value)
        elif node.tag == tag('instrText') and stack and stack[-1]['separator'] is None:
            stack[-1]['instruction'].append(node)
    if stack: raise ValueError('Unclosed Word field')
    return found

def containing_paragraph(node):
    parent = node
    while parent is not None and parent.tag != tag('p'): parent = parent.getparent()
    if parent is None: raise ValueError('Field is outside a paragraph')
    return parent

def catalogs(root):
    result = []
    for field in fields(root):
        if not re.match(r'^\s*TOC\b', field['code']): continue
        group = re.search(r'\\f\s+([CFT])(?:\s|$)', field['code'])
        if group is None: raise ValueError('Unsupported technical report TOC field')
        result.append((group[1], field))
    if [group for group, _ in result] != ['C', 'F', 'T']:
        raise ValueError('Expected the report main, figure and table fields in order')
    return result

def replace_cache(field, rows, toc_styles=None):
    if field['separator'] is None:
        raise ValueError('Catalog has no field separator')
    first = containing_paragraph(field['begin']); last = containing_paragraph(field['end'])
    parent = first.getparent()
    if parent is not last.getparent(): raise ValueError('Unsupported nested catalog block')
    start, end = parent.index(first), parent.index(last)
    if any(p.tag != tag('p') for p in list(parent)[start:end+1]):
        raise ValueError('Catalog spans non-paragraph content')
    separate_run = field['separator'].getparent(); end_run = field['end'].getparent()
    if separate_run.getparent() is not first or end_run.getparent() is not last:
        raise ValueError('Unsupported catalog field nesting')
    prefix = [deepcopy(n) for n in list(first)[:first.index(separate_run)+1] if n.tag != tag('pPr')]
    suffix = [deepcopy(n) for n in list(last)[last.index(end_run):] if n.tag != tag('pPr')]
    section = last.find('w:pPr/w:sectPr', NS)
    selected_section = section
    if selected_section is None:
        candidates = last.xpath('following::w:sectPr', namespaces=NS)
        if not candidates: raise ValueError('Catalog section geometry missing')
        selected_section = candidates[0]
    size = selected_section.find('w:pgSz', NS); margins = selected_section.find('w:pgMar', NS)
    if size is None or margins is None: raise ValueError('Catalog page geometry missing')
    columns = selected_section.find('w:cols', NS)
    if columns is not None and columns.get(tag('num'), '1') != '1': raise ValueError('Multicolumn catalog unsupported')
    width = int(size.get(tag('w'))) - sum(int(margins.get(tag(x), '0')) for x in ['left', 'right', 'gutter'])
    made = []
    for index, row in enumerate(rows or [None]):
        p = E.Element(tag('p')); props = E.SubElement(p, tag('pPr'))
        if row is not None and toc_styles is not None:
            E.SubElement(props, tag('pStyle')).set(tag('val'), toc_styles[row['level']])
            E.SubElement(props, tag('keepLines')).set(tag('val'), '1')
            tabs = E.SubElement(props, tag('tabs')); stop = E.SubElement(tabs, tag('tab'))
            stop.set(tag('val'), 'right'); stop.set(tag('leader'), 'dot'); stop.set(tag('pos'), str(width))
        if index == 0: p.extend(prefix)
        if row is None:
            run = E.SubElement(p, tag('r')); E.SubElement(run, tag('t')).text = ''
        elif toc_styles is None:
            run = E.SubElement(p, tag('r')); E.SubElement(run, tag('t')).text = row['label']
        else:
            link = E.SubElement(p, tag('hyperlink')); link.set(tag('anchor'), row['bookmark'])
            run = E.SubElement(link, tag('r')); E.SubElement(run, tag('t')).text = row['label']
            run = E.SubElement(link, tag('r')); E.SubElement(run, tag('tab'))
            run = E.SubElement(link, tag('r')); E.SubElement(run, tag('t')).text = row['page']
        if index == len(rows or [None])-1:
            p.extend(suffix)
            if section is not None: props.append(deepcopy(section))
        made.append(p)
    for p in list(parent)[start:end+1]: parent.remove(p)
    for i, p in enumerate(made): parent.insert(start+i, p)

def write_copy(source, output, changed):
    with ZipFile(source) as src, ZipFile(output, 'x') as dst:
        names = [member.filename for member in src.infolist()]
        if len(set(names)) != len(names):
            raise ValueError('Duplicate DOCX package member')
        for member in src.infolist():
            if member.filename in changed:
                dst.writestr(member, changed[member.filename])
            else:
                with src.open(member) as reader, dst.open(member, 'w') as writer:
                    shutil.copyfileobj(reader, writer, length=65536)


def prepare(source, directory):
    directory.mkdir(parents=True)
    with ZipFile(source) as z:
        document = parse_xml(z.read('word/document.xml'))
        styles = parse_xml(z.read('word/styles.xml'))
    catalogs(document)
    style_map = {n.get(tag('styleId')): n for n in styles.findall('w:style', NS)}
    default = next((sid for sid, n in style_map.items() if n.get(tag('type')) == 'paragraph'
                    and n.get(tag('default')) == '1'), 'Normal')
    def outline(style_id):
        seen = set()
        while style_id in style_map and style_id not in seen:
            seen.add(style_id); style = style_map[style_id]
            value = style.find('w:pPr/w:outlineLvl', NS)
            if value is not None: return int(value.get(tag('val')))+1
            base = style.find('w:basedOn', NS)
            style_id = None if base is None else base.get(tag('val'))
        return 10
    marks = {}
    for field in fields(document):
        if not re.match(r'^\s*TC\b', field['code']): continue
        group = re.search(r'\\f\s+([CFT])(?:\s|$)', field['code'])
        text = re.match(r'^\s*TC\s+"((?:\\.|[^"\\])*)"', field['code'])
        if group is None or text is None: raise ValueError('Unsupported report TC mark')
        paragraph = containing_paragraph(field['begin'])
        if paragraph in marks: raise ValueError('Multiple TC groups on one paragraph are unsupported')
        marks[paragraph] = (group[1], text[1].replace('\\"', '"').replace('\\\\', '\\'))
    groups = {'C': [], 'F': [], 'T': []}; targets = []
    next_id = max([int(v) for v in document.xpath('//w:bookmarkStart/@w:id', namespaces=NS)] or [0])+1
    for paragraph in document.iter(tag('p')):
        props = paragraph.find('w:pPr', NS); style = None if props is None else props.find('w:pStyle', NS)
        style_id = default if style is None else style.get(tag('val'))
        direct = None if props is None else props.find('w:outlineLvl', NS)
        level = int(direct.get(tag('val')))+1 if direct is not None else outline(style_id)
        visible = ''.join(paragraph.xpath('.//w:t/text()', namespaces=NS))
        marked = marks.get(paragraph)
        if marked is not None:
            group, label = marked; selected_level = 1
            if normalized(label) != normalized(visible): raise ValueError('TC text differs from visible caption/title')
        elif 1 <= level <= 3:
            group, label, selected_level = 'C', visible, level
        else: continue
        if not label.strip(): raise ValueError('Empty heading/mark')
        bookmark = None
        for existing in paragraph.findall('w:bookmarkStart', NS):
            candidate = existing.get(tag('name'), '')
            endings = paragraph.findall('w:bookmarkEnd', NS)
            matching = [n for n in endings if n.get(tag('id')) == existing.get(tag('id'))]
            if (re.fullmatch(r'DSHToc_[0-9]+', candidate)
                    and list(paragraph).index(existing) == (1 if props is not None else 0)
                    and len(matching) == 1 and paragraph[-1] is matching[0]):
                bookmark = candidate
                break
        if bookmark is None:
            bookmark = 'DSHToc_' + str(next_id)
            start = E.Element(tag('bookmarkStart'))
            start.set(tag('id'), str(next_id)); start.set(tag('name'), bookmark)
            end = E.Element(tag('bookmarkEnd')); end.set(tag('id'), str(next_id)); next_id += 1
            paragraph.insert(1 if props is not None else 0, start); paragraph.append(end)
        row = {'label': label, 'level': selected_level, 'bookmark': bookmark,
               'style': style_id, 'group': group}
        groups[group].append(row); targets.append((paragraph, row))
    # This copy preserves all original fields and paragraph styles; only link anchors are added.
    write_copy(source, directory/'original-anchors.docx', {'word/document.xml': xml(document)})
    toc_styles = catalog_styles(styles)
    aliases = {}; selected = {'C': {}, 'F': {}, 'T': {}}
    for paragraph, row in targets:
        key = (row['group'], row['level'], row['style'])
        if key not in aliases:
            alias = 'DSHTocStyle' + str(len(aliases)); aliases[key] = alias
            style = E.SubElement(styles, tag('style')); style.set(tag('type'), 'paragraph'); style.set(tag('styleId'), alias)
            E.SubElement(style, tag('name')).set(tag('val'), alias)
            E.SubElement(style, tag('basedOn')).set(tag('val'), row['style'])
        alias = aliases[key]; selected[row['group']][alias] = row['level']
        props = paragraph.find('w:pPr', NS)
        if props is None: props = E.Element(tag('pPr')); paragraph.insert(0, props)
        style = props.find('w:pStyle', NS)
        if style is None: style = E.SubElement(props, tag('pStyle'))
        style.set(tag('val'), alias)
    for group, field in catalogs(document):
        mapping = ','.join(f'{name},{level}' for name, level in selected[group].items()) or 'DSHUnusedStyle,1'
        field['instruction'][0].text = f' TOC \\t "{mapping}" \\h \\z '
        for n in field['instruction'][1:]: n.text = ''
        replace_cache(field, [{**row, 'page': '1'} for row in groups[group]], toc_styles)
    write_copy(source, directory/'native-working.docx', {'word/document.xml': xml(document), 'word/styles.xml': xml(styles)})
    (directory/'metadata.json').write_text(json.dumps(groups, ensure_ascii=False, indent=2)+'\n')

def catalog_styles(styles):
    toc_styles = {}
    for style in styles.findall('w:style', NS):
        name = style.find('w:name', NS)
        if name is not None:
            match = re.fullmatch(r'toc\s*([1-3])', name.get(tag('val'), ''), re.I)
            if match: toc_styles[int(match[1])] = style.get(tag('styleId'))
    if set(toc_styles) != {1, 2, 3}: raise ValueError('Expected the report TOC1/2/3 styles')
    return toc_styles

def apply_cache(directory, native_directory):
    original = directory/'original-anchors.docx'
    with ZipFile(original) as z:
        document = parse_xml(z.read('word/document.xml')); styles = parse_xml(z.read('word/styles.xml'))
    original_codes = [f['code'] for f in fields(document)]
    toc_styles = catalog_styles(styles)
    groups = json.loads((directory/'metadata.json').read_text())
    received = {}
    for i, (group, field) in enumerate(catalogs(document)):
        lines = [s for s in (native_directory/f'index-{i}.txt').read_text().splitlines() if s.strip()]
        if len(lines) != len(groups[group]): raise ValueError(f'Native {group} index size mismatch: {len(lines)} != {len(groups[group])}')
        rows = []
        for text, expected in zip(lines, groups[group]):
            label, page = text.rsplit('\t', 1); label = label.strip(); page = page.strip()
            if not normalized(label).endswith(normalized(expected['label'])): raise ValueError('Native entry order/title mismatch')
            if re.fullmatch(r'(\d+|[ivxlcdmIVXLCDM]+)', page) is None: raise ValueError('Unsupported native page label')
            rows.append({**expected, 'label': label, 'page': page})
        replace_cache(field, rows, toc_styles); received[group] = rows
    if [f['code'] for f in fields(document)] != original_codes: raise ValueError('Original Word field codes changed')
    write_copy(original, directory/'final.docx', {'word/document.xml': xml(document)})
    (directory/'cache.json').write_text(json.dumps(received, ensure_ascii=False, indent=2)+'\n')
