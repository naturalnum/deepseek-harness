"""Offline text and OCR extraction. Input files remain data, never executable."""
import base64, json, pathlib, subprocess, sys, tempfile

def run(args, timeout=30):
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout).stdout.decode('utf-8', errors='replace')

def extract(path, language):
    path=pathlib.Path(path)
    pages=[]
    with tempfile.TemporaryDirectory(prefix='epri-document-') as directory:
        if path.suffix.lower()=='.pdf':
            info=run(['pdfinfo',str(path)])
            total=int(next(line.split(':',1)[1].strip() for line in info.splitlines() if line.startswith('Pages:')))
            if total>80: raise ValueError('文件超过 80 页，请按章节拆分。')
            for page in range(1,total+1):
                text=run(['pdftotext','-f',str(page),'-l',str(page),'-layout',str(path),'-']).strip()
                method='text'
                if len(text.replace('\x0c','').strip())<12:
                    prefix=str(pathlib.Path(directory)/'page')
                    run(['pdftoppm','-f',str(page),'-l',str(page),'-r','160','-scale-to','2600','-singlefile','-png',str(path),prefix])
                    text=run(['tesseract',prefix+'.png','stdout','-l',language,'--psm','3'],45).strip();method='ocr'
                pages.append({'page':page,'text':text,'method':method})
        else:
            text=run(['tesseract',str(path),'stdout','-l',language,'--psm','3'],45).strip()
            pages.append({'page':1,'text':text,'method':'ocr'})
    return {'pages':pages,'language':language,'engine':'poppler+tesseract','reviewRequired':True}

if __name__=='__main__':
    try:
        if sys.argv[1]=='--stdin':
            payload=json.load(sys.stdin)
            if payload['extension'] not in ['.pdf','.png','.jpg','.jpeg','.tif','.tiff','.bmp']: raise ValueError('Unsupported document')
            if payload['language'] not in ['chi_sim+eng','eng','chi_sim']: raise ValueError('Unsupported language')
            with tempfile.TemporaryDirectory(prefix='epri-input-') as directory:
                path=pathlib.Path(directory)/('input'+payload['extension'])
                path.write_bytes(base64.b64decode(payload['contentBase64'],validate=True))
                result=extract(path,payload['language'])
        else:
            result=extract(sys.argv[1],sys.argv[2] if len(sys.argv)>2 else 'chi_sim+eng')
        print(json.dumps(result,ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error':str(error)},ensure_ascii=False));sys.exit(1)
