import React from "react";
export default function Icon({ size = 18 }: { size?: number; name?: string }) {
  return (
    <span aria-hidden style={{ fontSize: size }}>
      ◈
    </span>
  );
}
