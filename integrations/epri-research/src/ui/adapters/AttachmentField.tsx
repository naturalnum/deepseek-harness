import React, { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";

export const AttachmentBusyContext = createContext<(busy: boolean) => void>(() => {});

export default function AttachmentField({ value, label, disabled, onChange }: {
  value: unknown; label: string; disabled: boolean; onChange: (value: string) => void;
}) {
  const [item, setItem] = useState<any>(null), [error, setError] = useState(""), [uploading, setUploading] = useState(false);
  const reportBusy = useContext(AttachmentBusyContext);
  useEffect(() => {
    if (!uploading) return;
    reportBusy(true);
    return () => reportBusy(false);
  }, [uploading, reportBusy]);
  useEffect(() => {
    const controller = new AbortController();
    setItem(null); setError("");
    if (value) {
      if (typeof value !== "string" || !/^attachment:[a-f0-9]{64}$/.test(value)) setError("原记录仅保存了文件名，请重新上传附件。");
      else void api("attachment_get", { reference: value }, undefined, controller.signal).then(setItem).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    }
    return () => controller.abort();
  }, [value]);
  const upload = async (file: File) => {
    setError("");
    if (file.size > 2 * 1024 * 1024) { setError("附件最大为 2 MiB，请选择较小的文件。"); return; }
    setUploading(true);
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("无法读取附件"));
        reader.readAsDataURL(file);
      });
      const saved = await api("attachment_put", { name: file.name, contentBase64, requestId: crypto.randomUUID() });
      onChange(saved.reference);
    } catch (e: any) { setError(e.message); }
    finally { setUploading(false); }
  };
  const download = () => {
    const bytes = Uint8Array.from(atob(item.contentBase64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const a = document.createElement("a"); a.href = url; a.download = item.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <span className="attachment-field">
    {item && <button type="button" onClick={download} aria-label={`下载附件 ${item.name}`}>{item.name} · {item.size} 字节</button>}
    {!disabled && <input type="file" aria-label={`${label}附件`} disabled={uploading} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void upload(file); }} />}
    {uploading && <span role="status">正在上传…</span>}
    {error && <span role="alert">{error}</span>}
    {!item && disabled && !error && <span>{value ? "加载附件…" : "未上传附件"}</span>}
  </span>;
}
