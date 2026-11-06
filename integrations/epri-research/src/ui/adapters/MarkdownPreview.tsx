import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
export default function MarkdownPreview({
  content,
}: {
  content: string;
  [key: string]: unknown;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
