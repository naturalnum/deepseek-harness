"""Native offline PDF text / Chinese-English OCR. Models ship with the App."""
import base64
import contextlib
import json
import sys
from pathlib import Path



def create_ocr():
    import cv2
    # Bound the worker pool inside this isolated scientific process, before any model operation.
    cv2.setNumThreads(1)
    import rapidocr
    import onnxruntime  # Probe native DLLs even though RapidOCR loads models lazily.
    models = Path(rapidocr.__file__).parent / 'models'
    files = {'Det': 'PP-OCRv6_det_small.onnx', 'Cls': 'ch_ppocr_mobile_v2.0_cls_mobile.onnx', 'Rec': 'PP-OCRv6_rec_small.onnx'}
    for name in files.values():
        if not (models / name).is_file():
            raise FileNotFoundError('OCR 模型缺失，请完整解压 App：' + name)
    params = {stage + '.model_path': str(models / name) for stage, name in files.items()}
    params.update({'Det.limit_type': 'max', 'Det.limit_side_len': 1024, 'Global.log_level': 'error', 'EngineConfig.onnxruntime.intra_op_num_threads': 1, 'EngineConfig.onnxruntime.inter_op_num_threads': 1})
    return rapidocr.RapidOCR(params=params)


def _run_image_child(payload):
    """One joined image child in this managed process group; no library-heavy PDF/OCR overlap."""
    import subprocess
    import threading
    request = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    maximum, stderr_maximum = 8 * 1024 * 1024, 32768
    if len(request) > maximum:
        raise ValueError('OCR image input exceeds 8 MiB')
    process = subprocess.Popen([sys.executable, '-I', '-B', '-X', 'utf8', str(Path(__file__).resolve()), '--image-child'],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
    output, diagnostic, errors = bytearray(), bytearray(), []
    workers = []

    def stop():
        if process.poll() is None:
            try:
                process.kill()
            except ProcessLookupError:
                pass

    def read(stream, target, limit):
        try:
            while True:
                part = stream.read(65536)
                if not part:
                    break
                if len(target) + len(part) > limit:
                    errors.append('OCR child output exceeds its bounded pipe capacity')
                    stop()
                    break
                target.extend(part)
        except Exception as error:
            errors.append(str(error)[:1000])
            stop()
        finally:
            stream.close()

    def write():
        try:
            offset = 0
            while offset < len(request):
                count = process.stdin.write(memoryview(request)[offset:offset + 65536])
                if not count:
                    raise BrokenPipeError('OCR child input closed')
                offset += count
        except BrokenPipeError:
            pass
        except Exception as error:
            errors.append(str(error)[:1000])
            stop()
        finally:
            process.stdin.close()

    try:
        workers = [threading.Thread(target=read, args=(process.stdout, output, maximum)),
                   threading.Thread(target=read, args=(process.stderr, diagnostic, stderr_maximum)),
                   threading.Thread(target=write)]
        for worker in workers:
            worker.start()
        try:
            process.wait(timeout=60)
        except subprocess.TimeoutExpired as error:
            raise TimeoutError('OCR page exceeded 60 seconds') from error
    finally:
        stop()
        process.wait()
        for worker in workers:
            if worker.ident is not None:
                worker.join()
        for stream in [process.stdin, process.stdout, process.stderr]:
            stream.close()
    if errors:
        raise RuntimeError(errors[0])
    if process.returncode != 0:
        raise RuntimeError('OCR child failed: ' + diagnostic.decode('utf-8', errors='replace')[:3000])
    result = json.loads(output)
    if not isinstance(result, dict) or not isinstance(result.get('pages'), list) or len(result['pages']) != 1:
        raise ValueError('OCR image child returned an invalid page result')
    page = result['pages'][0]
    if page.get('page') != 1 or page.get('method') != 'ocr' or not isinstance(page.get('text'), str):
        raise ValueError('OCR image child returned invalid text metadata')
    return page['text']


def extract(payload):
    content = base64.b64decode(payload['contentBase64'], validate=True)
    pages = []
    ocr = None

    def recognize(image):
        nonlocal ocr
        rgb = image if image.mode == 'RGB' else image.convert('RGB')
        array = result = None
        try:
            array = np.array(rgb, copy=True)
            if rgb is not image:
                rgb.close()
            image.close()
            if ocr is None:
                ocr = create_ocr()
            result = ocr(array)
            return '\n'.join(result.txts or [])
        finally:
            result = array = None
            if rgb is not image:
                rgb.close()

    if payload['extension'] == '.pdf':
        import pymupdf
        with pymupdf.open(stream=content, filetype='pdf') as document:
            if document.needs_pass:
                raise ValueError('PDF 已加密，请提供可读取的文件。')
            if document.page_count > 80:
                raise ValueError('文件超过 80 页，请按章节拆分。')
            total_bytes = 0
            for index, page in enumerate(document):
                text = page.get_text(sort=True).strip()
                method = 'text'
                if len(text) < 12:
                    scale = min(160 / 72, 2600 / max(page.rect.width, page.rect.height))
                    pixels = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False, colorspace=pymupdf.csRGB)
                    try:
                        png = pixels.tobytes('png')
                    finally:
                        del pixels
                        pymupdf.TOOLS.store_shrink(100)
                    try:
                        text = _run_image_child({'extension':'.png', 'language':payload['language'],
                                                 'contentBase64':base64.b64encode(png).decode('ascii')})
                    finally:
                        del png
                        pymupdf.TOOLS.store_shrink(100)
                    method = 'ocr'
                entry = {'page': index + 1, 'text': text, 'method': method}
                total_bytes += len(json.dumps(entry, ensure_ascii=False).encode('utf-8'))
                if total_bytes > 8 * 1024 * 1024 - 1024:
                    raise ValueError('Document text exceeds 8 MiB')
                pages.append(entry)
    else:
        import io
        import numpy as np
        from PIL import Image, ImageOps, ImageSequence
        with Image.open(io.BytesIO(content)) as image:
            if getattr(image, 'n_frames', 1) > 80:
                raise ValueError('文件超过 80 页，请拆分。')
            for index, frame in enumerate(ImageSequence.Iterator(image)):
                frame = ImageOps.exif_transpose(frame).convert('RGB')
                try:
                    frame.thumbnail((2600, 2600))
                    pages.append({'page': index + 1, 'text': recognize(frame), 'method': 'ocr'})
                finally:
                    frame.close()
    return {'pages': pages, 'language': payload['language'], 'engine': 'pymupdf+rapidocr-onnx', 'reviewRequired': True}


if __name__ == '__main__':
    try:
        if '--status' in sys.argv:
            create_ocr()
            print(json.dumps({'available': True}))
            sys.exit(0)
        payload = json.load(sys.stdin)
        if payload['extension'] not in ['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp']:
            raise ValueError('Unsupported document')
        if payload['language'] not in ['chi_sim+eng', 'eng', 'chi_sim']:
            raise ValueError('Unsupported language')
        if '--image-child' in sys.argv and payload['extension'] == '.pdf':
            raise ValueError('Internal image child does not accept PDF input')
        with contextlib.redirect_stdout(sys.stderr):
            result = extract(payload)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
