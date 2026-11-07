# 公式因子与符号挖掘

用于用户要求“自动找公式”“进化因子”“符号回归”时。目标是生成可解释、可检查、可复现的候选，而不是最大化样本内结果。

## 1. gplearn 路线

gplearn 提供 scikit-learn 风格的符号回归/转换器，可用于从原始特征组合出候选因子。

建议：

- 限制函数集：`add/sub/mul/div/rank/ts_delta/ts_mean` 等金融可解释操作。
- 使用 walk-forward 或时间切分，不要随机打乱时间序列。
- 对复杂度加惩罚，优先短公式。
- 输出每个公式的经济解释、泄漏风险和稳定性。

## 2. AlphaForge / QuantaAlpha 路线

AlphaForge 和 QuantaAlpha 更适合提炼“搜索策略”：

- 多机制并行，不只改窗口。
- 每轮保留失败原因和下一轮变异方向。
- 对相关性、换手、容量和样本外表现设置门控。

## 3. 生成候选的输出格式

```json
{
  "name": "quality_revision_momentum",
  "hypothesis": "盈利质量改善后，分析师修正和价格动量共同确认基本面变化。",
  "expression": "rank(ts_delta(roe, 63)) + rank(ts_delta(est_eps, 21))",
  "required_fields": ["roe", "est_eps", "close"],
  "leakage_checks": ["财报可得时间", "分析师数据发布时间", "价格复权方式"],
  "expected_risks": ["拥挤质量因子", "行业暴露", "高换手"]
}
```

## 4. 禁止

- 不要把样本内最优公式直接当成有效因子。
- 不要输出无法解释的数据挖掘表达式。
- 不要忽略复杂度、交易成本和低流动性风险。
