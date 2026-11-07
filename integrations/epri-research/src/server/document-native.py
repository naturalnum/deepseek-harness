"""Native offline PDF text / Chinese-English OCR. Models ship with the App."""
import base64
import contextlib
import json
import sys
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image, ImageOps, ImageSequence


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


def extract(payload):
    content = base64.b64decode(payload['contentBase64'], validate=True)
    pages = []
    ocr = None

    def recognize(image):
        nonlocal ocr
        if ocr is None:
            ocr = create_ocr()
        result = ocr(np.array(image.convert('RGB')))
        return '\n'.join(result.txts or [])

    if payload['extension'] == '.pdf':
        with pymupdf.open(stream=content, filetype='pdf') as document:
            if document.needs_pass:
                raise ValueError('PDF 已加密，请提供可读取的文件。')
            if document.page_count > 80:
                raise ValueError('文件超过 80 页，请按章节拆分。')
            for index, page in enumerate(document):
                text = page.get_text(sort=True).strip()
                method = 'text'
                if len(text) < 12:
                    scale = min(160 / 72, 2600 / max(page.rect.width, page.rect.height))
                    pixels = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False, colorspace=pymupdf.csRGB)
                    text = recognize(Image.frombytes('RGB', (pixels.width, pixels.height), pixels.samples))
                    method = 'ocr'
                pages.append({'page': index + 1, 'text': text, 'method': method})
    else:
        import io
        with Image.open(io.BytesIO(content)) as image:
            if getattr(image, 'n_frames', 1) > 80:
                raise ValueError('文件超过 80 页，请拆分。')
            for index, frame in enumerate(ImageSequence.Iterator(image)):
                frame = ImageOps.exif_transpose(frame).convert('RGB')
                frame.thumbnail((2600, 2600))
                pages.append({'page': index + 1, 'text': recognize(frame), 'method': 'ocr'})
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
        with contextlib.redirect_stdout(sys.stderr):
            result = extract(payload)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
