#!/usr/bin/env python3
"""修复 output/ 目录中所有 JSON 文件的格式错误。

使用 json_repair 库自动检测并修复常见 JSON 问题：
  - 未转义的双引号（HTML 属性 style="..." 等）
  - 字符串中的实际换行符
  - 尾部逗号
  - 缺失括号
  - 单引号替代双引号
  - Python 布尔值 (True/False/None)

用法:
    python3 scripts/repair_json.py
"""

import json
import os
import sys

from utils import get_output_path


def repair_file(filepath: str) -> bool:
    """
    尝试修复单个 JSON 文件。

    Returns:
        True: 文件有问题，已修复
        False: 文件无需修复（已经是合法 JSON）
    """
    with open(filepath, "r", encoding="utf-8") as f:
        raw = f.read()

    # 先检查是否已经合法
    try:
        json.loads(raw)
        return False
    except json.JSONDecodeError:
        pass

    # 尝试 json_repair 修复
    try:
        from json_repair import repair_json  # type: ignore[import-untyped]
    except ImportError:
        print(
            "错误: 需要安装 json-repair，请运行: pip install json-repair",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        fixed = repair_json(raw)
        data = json.loads(fixed)  # 验证修复后可解析
    except Exception as e:
        print(f"✗  无法修复 {os.path.basename(filepath)}: {e}", file=sys.stderr)
        return False

    # 写回格式化后的 JSON
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return True


def main():
    output_dir = os.path.dirname(get_output_path(""))

    if not os.path.exists(output_dir):
        print("output/ 目录不存在")
        return

    json_files = sorted(
        f for f in os.listdir(output_dir) if f.endswith(".json")
    )

    if not json_files:
        print("output/ 目录中没有 JSON 文件")
        return

    fixed_count = 0
    for fname in json_files:
        filepath = os.path.join(output_dir, fname)
        try:
            if repair_file(filepath):
                print(f"✅ 已修复: {fname}")
                fixed_count += 1
            else:
                print(f"✓  无需修复: {fname}")
        except Exception as e:
            print(f"✗  读取失败 {fname}: {e}", file=sys.stderr)

    print(f"\n修复完成: {fixed_count}/{len(json_files)} 个文件")


if __name__ == "__main__":
    main()
